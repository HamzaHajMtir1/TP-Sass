# ---------- Image de l'application To-Do ----------
# Image légère basée sur Alpine Linux
FROM node:22-alpine

# Dossier de travail dans le conteneur
WORKDIR /usr/src/app

# 1) On copie d'abord package*.json pour profiter du cache Docker :
#    les dépendances ne sont réinstallées que si ces fichiers changent.
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# 2) Puis le code source
COPY . .

# Version affichée dans l'interface : docker build --build-arg APP_VERSION=v2 ...
ARG APP_VERSION=v1

# Variables par défaut (surchargeables par docker-compose / Kubernetes)
ENV NODE_ENV=production \
    PORT=3000 \
    APP_VERSION=${APP_VERSION}

# Sécurité : on n'exécute pas l'application en root
USER node

EXPOSE 3000

# Vérification de santé utilisée par Docker (Kubernetes utilise ses propres probes)
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "server.js"]
