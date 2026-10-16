# TP — Déploiement d'une application Node.js avec Docker et Kubernetes sur AWS

Petite application **To-Do List** (Node.js / Express + MongoDB) conteneurisée avec **Docker**, puis déployée sur **Kubernetes (Amazon EKS)** depuis un compte **AWS Academy Learner Lab**.

## Architecture

```
                 Internet
                    │
          ┌─────────▼─────────┐
          │  AWS Load Balancer │   ← créé par le Service "LoadBalancer"
          └─────────┬─────────┘
   Cluster EKS      │  (namespace "todo")
  ┌─────────────────┼──────────────────────────┐
  │        ┌────────▼────────┐                 │
  │        │ Service todo-app│                 │
  │        └───┬─────────┬───┘                 │
  │   ┌────────▼──┐  ┌───▼───────┐             │
  │   │ Pod app #1│  │ Pod app #2│  ← image ECR│
  │   └────────┬──┘  └───┬───────┘             │
  │        ┌───▼─────────▼───┐                 │
  │        │  Service mongo  │ (ClusterIP)     │
  │        └────────┬────────┘                 │
  │            ┌────▼─────┐                    │
  │            │ Pod Mongo│                    │
  │            └──────────┘                    │
  └────────────────────────────────────────────┘
```

## Structure du projet

```
todo-k8s-aws/
├── app/
│   ├── server.js            # API REST Express (+ /health, /api/info)
│   ├── public/index.html    # Interface web
│   ├── package.json
│   ├── Dockerfile
│   └── .dockerignore
├── k8s/
│   ├── 00-namespace.yaml    # Namespace "todo"
│   ├── 01-mongo.yaml        # Deployment + Service MongoDB
│   ├── 02-configmap.yaml    # Configuration (MONGO_URL…)
│   ├── 03-todo-deployment.yaml  # Deployment de l'app (2 répliques, probes)
│   └── 04-todo-service.yaml # Service LoadBalancer (accès public)
├── docker-compose.yml       # Test local
└── README.md
```

### API

| Méthode | Route             | Rôle                                   |
|---------|-------------------|----------------------------------------|
| GET     | `/api/todos`      | Lister les tâches                      |
| POST    | `/api/todos`      | Créer `{ "title": "..." }`             |
| PATCH   | `/api/todos/:id`  | Modifier `{ "done": true }` / `title`  |
| DELETE  | `/api/todos/:id`  | Supprimer                              |
| GET     | `/health`         | Santé (utilisé par les probes K8s)     |
| GET     | `/api/info`       | Nom du pod + version (load balancing)  |

Sans variable `MONGO_URL`, l'application stocke les tâches en mémoire (pratique pour un test rapide avec `npm start`).

---

## Étape 0 — Tester en local (optionnel)

Avec Docker Desktop installé sur votre PC :

```bash
docker compose up --build
# ouvrir http://localhost:3000
docker compose down
```

---

## Étape 1 — Démarrer le Learner Lab

1. AWS Academy → votre cours → **Modules** → **Learner Lab**.
2. Cliquer **Start Lab**, attendre le voyant **vert**, puis cliquer **AWS** pour ouvrir la console.
3. Vérifier que la région est **us-east-1 (N. Virginia)**.

> Dans le Learner Lab on **ne peut pas créer de rôles IAM**. On utilise le rôle déjà créé **`LabRole`** (et le profil d'instance **`LabInstanceProfile`**) partout où AWS demande un rôle.

---

## Étape 2 — Créer une instance EC2 « poste d'administration »

C'est depuis cette machine qu'on construit l'image Docker et qu'on pilote le cluster avec `kubectl`. (Avantage : elle est en x86_64 comme les nœuds EKS, et elle a automatiquement les droits de `LabRole`.)

1. **EC2 → Launch instance**
   - Nom : `admin-k8s`
   - AMI : **Amazon Linux 2023**
   - Type : **t3.small** (ou t3.medium)
   - Key pair : **vockey**
   - Security group : autoriser **SSH (22)**
   - **Advanced details → IAM instance profile : `LabInstanceProfile`** ← important
2. Se connecter : sélectionner l'instance → **Connect → EC2 Instance Connect**.
3. Installer les outils :

```bash
# Docker + Git
sudo dnf install -y docker git
sudo systemctl enable --now docker
sudo usermod -aG docker ec2-user
newgrp docker            # recharge les groupes sans se déconnecter

# kubectl
curl -LO "https://dl.k8s.io/release/$(curl -Ls https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
sudo install -m 0755 kubectl /usr/local/bin/kubectl && rm kubectl

# Vérifications
docker --version && kubectl version --client && aws sts get-caller-identity
```

4. Récupérer le projet sur l'instance (au choix) :
   - Pousser le dossier sur votre GitHub puis `git clone https://github.com/<vous>/todo-k8s-aws.git`
   - ou depuis votre PC : `scp -i labsuser.pem todo-k8s-aws.zip ec2-user@<IP_PUBLIQUE>:~` puis `unzip todo-k8s-aws.zip`
     (`labsuser.pem` se télécharge dans **AWS Details → Download PEM**)

```bash
cd ~/todo-k8s-aws
```

---

## Étape 3 — Construire l'image et la pousser sur Amazon ECR

```bash
export AWS_REGION=us-east-1
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export REPO=$ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/todo-app

# 1. Créer le dépôt ECR
aws ecr create-repository --repository-name todo-app --region $AWS_REGION

# 2. Authentifier Docker auprès d'ECR
aws ecr get-login-password --region $AWS_REGION \
  | docker login --username AWS --password-stdin $ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com

# 3. Construire, tagger et pousser
docker build -t todo-app:v1 ./app
docker tag todo-app:v1 $REPO:v1
docker push $REPO:v1
```

Vérifier dans la console : **ECR → Repositories → todo-app** → l'image `v1` apparaît.

> Si vous construisez sur un Mac M1/M2/M3, ajoutez `--platform linux/amd64` au `docker build`, sinon les pods afficheront `exec format error`.

---

## Étape 4 — Créer le cluster EKS (console)

### 4.1 Le cluster (≈ 10–15 min)

**EKS → Clusters → Create cluster → Custom configuration**

| Paramètre | Valeur |
|-----------|--------|
| EKS Auto Mode | **Désactivé** |
| Name | `todo-cluster` |
| Cluster IAM role | **LabRole** |
| Kubernetes version | celle proposée par défaut |
| VPC | VPC par défaut |
| Subnets | ceux de us-east-1**a**, **b**, **c** (⚠️ décocher **us-east-1e**, non supporté par EKS) |
| Cluster endpoint access | **Public** |
| Add-ons | laisser ceux par défaut |

Attendre le statut **Active**.

### 4.2 Donner l'accès admin à `LabRole`

La console crée le cluster avec votre identité de console (`voclabs`), mais l'instance EC2 utilise `LabRole`. Il faut donc autoriser `LabRole` :

**Cluster → onglet Access → Create access entry**
- IAM principal : `arn:aws:iam::<ACCOUNT_ID>:role/LabRole`
- Type : Standard → **Next**
- Policy : **AmazonEKSClusterAdminPolicy**, Access scope : **Cluster** → **Add policy** → **Create**

### 4.3 Les nœuds (worker nodes) (≈ 5 min)

**Cluster → onglet Compute → Add node group**

| Paramètre | Valeur |
|-----------|--------|
| Name | `todo-nodes` |
| Node IAM role | **LabRole** |
| AMI type | Amazon Linux 2023 (x86_64) |
| Instance type | **t3.medium** |
| Desired / Min / Max | **2 / 1 / 3** |
| Subnets | les mêmes que le cluster |

Attendre le statut **Active**.

---

## Étape 5 — Connecter kubectl au cluster

Sur l'instance `admin-k8s` :

```bash
aws eks update-kubeconfig --name todo-cluster --region us-east-1
kubectl get nodes
```

Vous devez voir 2 nœuds en état **Ready**.

---

## Étape 6 — Déployer l'application

```bash
# Mettre l'ID du compte dans le manifest de l'application
sed -i "s|<ACCOUNT_ID>|$ACCOUNT_ID|" k8s/03-todo-deployment.yaml

# Tout déployer (les fichiers sont appliqués dans l'ordre 00 → 04)
kubectl apply -f k8s/

# Suivre le démarrage
kubectl get all -n todo
kubectl get pods -n todo -w      # Ctrl+C quand tout est Running 1/1
```

Récupérer l'URL publique :

```bash
kubectl get svc todo-app -n todo
```

Copier la valeur **EXTERNAL-IP** (du type `xxxx.us-east-1.elb.amazonaws.com`) et l'ouvrir dans le navigateur : `http://<EXTERNAL-IP>`.
Le DNS du load balancer peut mettre **2 à 3 minutes** à répondre.

---

## Étape 7 — Manipulations à faire (et à capturer pour le rapport)

**1. Répartition de charge** — le nom du pod change selon la réplique qui répond :
```bash
URL=$(kubectl get svc todo-app -n todo -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')
for i in $(seq 1 10); do curl -s http://$URL/api/info; echo; done
```

**2. Auto-réparation (self-healing)** — supprimer un pod, Kubernetes en recrée un :
```bash
kubectl get pods -n todo
kubectl delete pod <nom-d-un-pod-todo-app> -n todo
kubectl get pods -n todo -w
```

**3. Mise à l'échelle (scaling)** :
```bash
kubectl scale deployment todo-app --replicas=4 -n todo
kubectl get pods -n todo
```

**4. Mise à jour sans interruption (rolling update) vers la v2** :
```bash
docker build --build-arg APP_VERSION=v2 -t $REPO:v2 ./app
docker push $REPO:v2
kubectl set image deployment/todo-app todo-app=$REPO:v2 -n todo
kubectl rollout status deployment/todo-app -n todo
```
Recharger la page : le badge affiche **Version : v2**.

**5. Retour arrière (rollback)** :
```bash
kubectl rollout history deployment/todo-app -n todo
kubectl rollout undo deployment/todo-app -n todo
```

**6. Logs et diagnostic** :
```bash
kubectl logs -l app=todo-app -n todo --tail=20
kubectl describe deployment todo-app -n todo
```

---

## Étape 8 — Nettoyage (important pour le budget du lab)

Le plan de contrôle EKS est facturé à l'heure, même quand la session du lab est terminée. À la fin du TP :

```bash
kubectl delete -f k8s/          # supprime d'abord le Load Balancer AWS
```

Puis dans la console :
1. **EKS → todo-cluster → Compute** → supprimer le node group `todo-nodes` (attendre).
2. **EKS** → supprimer le cluster `todo-cluster`.
3. **ECR** → supprimer le dépôt `todo-app`.
4. **EC2** → terminer l'instance `admin-k8s`.

---

## Variante B — Sans EKS : Kubernetes léger (k3s) sur une seule EC2

Si EKS n'est pas disponible dans votre lab ou pour économiser le budget, les **mêmes manifests** fonctionnent sur **k3s** (Kubernetes certifié, en une commande).

1. Lancer une EC2 **Amazon Linux 2023**, **t3.medium**, key pair **vockey**, `LabInstanceProfile`, security group : **SSH (22)** et **HTTP (80)**.
2. Installer Docker et Git (comme à l'étape 2), copier le projet, puis :

```bash
# Installer k3s
curl -sfL https://get.k3s.io | sh -
mkdir -p ~/.kube && sudo cp /etc/rancher/k3s/k3s.yaml ~/.kube/config && sudo chown $USER ~/.kube/config
kubectl get nodes

# Construire l'image et l'importer directement dans k3s (pas besoin d'ECR)
cd ~/todo-k8s-aws
docker build -t todo-app:v1 ./app
docker save todo-app:v1 | sudo k3s ctr images import -

# Adapter le manifest à l'image locale
sed -i -e 's|image: .*todo-app:v1|image: docker.io/library/todo-app:v1|' \
       -e 's|imagePullPolicy: Always|imagePullPolicy: IfNotPresent|' k8s/03-todo-deployment.yaml

kubectl apply -f k8s/
kubectl get pods -n todo -w
```

3. Ouvrir `http://<IP_PUBLIQUE_EC2>` (le Service LoadBalancer de k3s écoute sur le port 80 de l'instance).

---

## Dépannage

| Symptôme | Cause probable / solution |
|----------|---------------------------|
| `error: You must be logged in to the server (Unauthorized)` | L'access entry pour `LabRole` manque (étape 4.2). Autre solution : copier les identifiants de **AWS Details → AWS CLI** dans `~/.aws/credentials` de l'instance (à refaire à chaque session). |
| Pod en `ImagePullBackOff` | `<ACCOUNT_ID>` non remplacé, mauvais tag, ou image non poussée. Vérifier avec `kubectl describe pod <pod> -n todo`. |
| Pod en `CrashLoopBackOff` avec `exec format error` | Image construite en ARM (Mac M1/M2). Reconstruire avec `--platform linux/amd64`. |
| Pods app `Running` mais `0/1` | MongoDB pas encore prêt : l'app réessaie, attendre ~30 s. Voir `kubectl logs`. |
| `EXTERNAL-IP` reste `<pending>` | Attendre 2–3 min. Sinon `kubectl describe svc todo-app -n todo` ; ajouter le tag `kubernetes.io/role/elb = 1` sur les sous-réseaux publics du VPC. |
| La page ne charge pas tout de suite | Le DNS de l'ELB se propage en quelques minutes. |
| Plus rien ne marche après une pause | La session du lab a expiré : **Start Lab** à nouveau, les instances redémarrent. |

## Pour aller plus loin

- Stockage persistant pour MongoDB : add-on **Amazon EBS CSI Driver** + `PersistentVolumeClaim` à la place de `emptyDir`.
- Mise à l'échelle automatique : `kubectl autoscale deployment todo-app --cpu-percent=50 --min=2 --max=5 -n todo` (nécessite metrics-server).
- Pipeline CI/CD : GitHub Actions qui construit l'image, la pousse sur ECR et exécute `kubectl set image`.
