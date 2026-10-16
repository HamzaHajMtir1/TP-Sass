// ------------------------------------------------------------
//  To-Do List API — Node.js / Express / MongoDB
//  TP : Déploiement avec Docker et Kubernetes sur AWS
// ------------------------------------------------------------
const express = require("express");
const os = require("os");
const path = require("path");
const { MongoClient, ObjectId } = require("mongodb");

const PORT = process.env.PORT || 3000;
const MONGO_URL = process.env.MONGO_URL || ""; // ex: mongodb://mongo:27017/todos
const APP_VERSION = process.env.APP_VERSION || "v1";

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ------------------------------------------------------------
//  Stockage : MongoDB si MONGO_URL est défini, sinon mémoire
// ------------------------------------------------------------
let collection = null;           // collection MongoDB
let memoryTodos = [];            // stockage de secours (sans MongoDB)
let memoryId = 1;
let dbReady = !MONGO_URL;        // en mode mémoire, on est prêt tout de suite

async function connectMongo(retries = 10) {
  for (let i = 1; i <= retries; i++) {
    try {
      const client = new MongoClient(MONGO_URL, { serverSelectionTimeoutMS: 3000 });
      await client.connect();
      collection = client.db().collection("todos");
      dbReady = true;
      console.log(`✅ Connecté à MongoDB (${MONGO_URL})`);
      return;
    } catch (err) {
      console.log(`⏳ MongoDB indisponible (tentative ${i}/${retries}) : ${err.message}`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  console.error("❌ Impossible de se connecter à MongoDB, arrêt.");
  process.exit(1); // Kubernetes redémarrera le pod
}

// Formate un document Mongo -> objet JSON propre
const toJSON = (d) => ({ id: String(d._id), title: d.title, done: d.done, createdAt: d.createdAt });

// ------------------------------------------------------------
//  Routes techniques (utilisées par Docker / Kubernetes)
// ------------------------------------------------------------
app.get("/health", (req, res) => {
  if (!dbReady) return res.status(503).json({ status: "starting" });
  res.json({ status: "ok" });
});

// Indique quel pod a répondu : pratique pour voir le load-balancing
app.get("/api/info", (req, res) => {
  res.json({
    hostname: os.hostname(),
    version: APP_VERSION,
    storage: MONGO_URL ? "mongodb" : "memory",
  });
});

// ------------------------------------------------------------
//  API REST /api/todos
// ------------------------------------------------------------
app.get("/api/todos", async (req, res, next) => {
  try {
    if (!collection) return res.json(memoryTodos);
    const docs = await collection.find().sort({ createdAt: -1 }).toArray();
    res.json(docs.map(toJSON));
  } catch (e) { next(e); }
});

app.post("/api/todos", async (req, res, next) => {
  try {
    const title = (req.body.title || "").trim();
    if (!title) return res.status(400).json({ error: "Le champ 'title' est obligatoire" });

    const todo = { title, done: false, createdAt: new Date() };
    if (!collection) {
      const t = { id: String(memoryId++), ...todo };
      memoryTodos.unshift(t);
      return res.status(201).json(t);
    }
    const { insertedId } = await collection.insertOne(todo);
    res.status(201).json(toJSON({ _id: insertedId, ...todo }));
  } catch (e) { next(e); }
});

app.patch("/api/todos/:id", async (req, res, next) => {
  try {
    const update = {};
    if (typeof req.body.done === "boolean") update.done = req.body.done;
    if (typeof req.body.title === "string" && req.body.title.trim()) update.title = req.body.title.trim();

    if (!collection) {
      const t = memoryTodos.find((x) => x.id === req.params.id);
      if (!t) return res.status(404).json({ error: "Tâche introuvable" });
      Object.assign(t, update);
      return res.json(t);
    }
    if (!ObjectId.isValid(req.params.id)) return res.status(404).json({ error: "Tâche introuvable" });
    const doc = await collection.findOneAndUpdate(
      { _id: new ObjectId(req.params.id) },
      { $set: update },
      { returnDocument: "after" }
    );
    if (!doc) return res.status(404).json({ error: "Tâche introuvable" });
    res.json(toJSON(doc));
  } catch (e) { next(e); }
});

app.delete("/api/todos/:id", async (req, res, next) => {
  try {
    if (!collection) {
      const before = memoryTodos.length;
      memoryTodos = memoryTodos.filter((x) => x.id !== req.params.id);
      if (memoryTodos.length === before) return res.status(404).json({ error: "Tâche introuvable" });
      return res.status(204).end();
    }
    if (!ObjectId.isValid(req.params.id)) return res.status(404).json({ error: "Tâche introuvable" });
    const r = await collection.deleteOne({ _id: new ObjectId(req.params.id) });
    if (r.deletedCount === 0) return res.status(404).json({ error: "Tâche introuvable" });
    res.status(204).end();
  } catch (e) { next(e); }
});

// Gestion d'erreurs générique
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Erreur interne du serveur" });
});

// ------------------------------------------------------------
//  Démarrage
// ------------------------------------------------------------
const server = app.listen(PORT, () => {
  console.log(`🚀 To-Do app ${APP_VERSION} sur le port ${PORT} (pod: ${os.hostname()})`);
  if (MONGO_URL) connectMongo();
  else console.log("ℹ️  MONGO_URL non défini : stockage en mémoire");
});

// Arrêt propre quand Kubernetes envoie SIGTERM (rolling update, scale down…)
process.on("SIGTERM", () => {
  console.log("SIGTERM reçu, arrêt propre…");
  server.close(() => process.exit(0));
});
