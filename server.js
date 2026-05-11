import { createServer } from "node:http";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes, randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, "data");
const logsDir = join(__dirname, "logs");
const dbPath = join(dataDir, "profiles.json");
const logPath = join(logsDir, "server.log");
const port = Number(process.env.PORT || 8787);
const fileLogsEnabled = process.env.FILE_LOGS === "1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, ngrok-skip-browser-warning",
  "Access-Control-Allow-Private-Network": "true",
  "Access-Control-Max-Age": "86400"
};

const server = createServer(async (req, res) => {
  const startedAt = Date.now();
  const requestId = randomUUID().slice(0, 8);
  const urlForLog = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  log("request:start", {
    requestId,
    method: req.method,
    path: urlForLog.pathname,
    query: safeQuery(urlForLog),
    origin: req.headers.origin || "",
    userAgent: req.headers["user-agent"] || ""
  });

  res.on("finish", () => {
    log("request:end", {
      requestId,
      method: req.method,
      path: urlForLog.pathname,
      status: res.statusCode,
      durationMs: Date.now() - startedAt
    });
  });

  try {
    if (req.method === "OPTIONS") return send(res, 204);

    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, { ok: true, service: "panini-2026-sync-backend" });
    }

    if (req.method === "GET" && url.pathname === "/api/profiles") {
      const db = await readDb();
      const authUser = userFromRequest(req, db);
      const profiles = Object.values(db.profiles)
        .filter((profile) => !authUser || profile.ownerId !== authUser.id)
        .map(publicProfile)
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
      return json(res, 200, { profiles });
    }

    if (req.method === "GET" && url.pathname === "/api/users") {
      const db = await readDb();
      const authUser = userFromRequest(req, db);
      const query = cleanUsername(url.searchParams.get("q") || "");
      const users = Object.values(db.users)
        .filter((user) => user.id !== authUser?.id)
        .filter((user) => !query || user.username.includes(query) || String(user.displayName || "").toLowerCase().includes(query))
        .slice(0, 12)
        .map((user) => {
          const profile = Object.values(db.profiles).find((item) => item.ownerId === user.id);
          return {
            ...publicUser(user),
            hasProfile: Boolean(profile),
            updatedAt: profile?.updatedAt || ""
          };
        });
      log("users:search", { requestId, query, count: users.length, authUser: authUser?.username || "" });
      return json(res, 200, { users });
    }

    const userProfileMatch = url.pathname.match(/^\/api\/users\/([^/]+)\/profile$/);
    if (req.method === "GET" && userProfileMatch) {
      const db = await readDb();
      const username = cleanUsername(decodeURIComponent(userProfileMatch[1]));
      const user = db.users[username];
      if (!user) return json(res, 404, { error: "user_not_found" });
      const profile = Object.values(db.profiles).find((item) => item.ownerId === user.id);
      log("user:profile", { requestId, username, profileFound: Boolean(profile) });
      if (!profile) return json(res, 404, { error: "profile_not_found" });
      return json(res, 200, { profile: publicProfile(profile) });
    }

    if (req.method === "POST" && url.pathname === "/api/auth/register") {
      const payload = await readJsonBody(req);
      const db = await readDb();
      const username = cleanUsername(payload.username);
      const password = cleanText(payload.password, 200);
      const displayName = cleanText(payload.displayName || payload.username, 80);
      if (!username || password.length < 4) return json(res, 400, { error: "invalid_credentials" });
      if (db.users[username]) return json(res, 409, { error: "user_exists" });

      const user = createUser(username, password, displayName);
      db.users[username] = user;
      await writeDb(db);
      log("auth:register", { requestId, username, userId: user.id });
      return json(res, 200, authPayload(user));
    }

    if (req.method === "POST" && url.pathname === "/api/auth/login") {
      const payload = await readJsonBody(req);
      const db = await readDb();
      const username = cleanUsername(payload.username);
      const password = cleanText(payload.password, 200);
      const user = db.users[username];
      if (!user || user.passwordHash !== hashPassword(password, user.salt)) {
        log("auth:login_failed", { requestId, username });
        return json(res, 401, { error: "invalid_login" });
      }
      log("auth:login", { requestId, username, userId: user.id });
      return json(res, 200, authPayload(user));
    }

    if (req.method === "GET" && url.pathname === "/api/me") {
      const db = await readDb();
      const user = requireUser(req, res, db);
      if (!user) return;
      return json(res, 200, { user: publicUser(user) });
    }

    if (req.method === "GET" && url.pathname === "/api/me/profile") {
      const db = await readDb();
      const user = requireUser(req, res, db);
      if (!user) return;
      const profile = Object.values(db.profiles).find((item) => item.ownerId === user.id);
      log("me:profile", { requestId, username: user.username, profileFound: Boolean(profile) });
      return json(res, 200, { profile: profile ? publicProfile(profile) : null });
    }

    const profileMatch = url.pathname.match(/^\/api\/profiles\/([^/]+)$/);
    if (req.method === "GET" && profileMatch) {
      const db = await readDb();
      const profile = db.profiles[profileMatch[1]];
      if (!profile) return json(res, 404, { error: "profile_not_found" });
      return json(res, 200, { profile: publicProfile(profile) });
    }

    if (req.method === "POST" && url.pathname === "/api/profiles") {
      const payload = await readJsonBody(req);
      const db = await readDb();
      const authUser = userFromRequest(req, db);
      const existingId = authUser ? `user-${authUser.id}` : cleanId(payload.id || payload.userId || payload.profileId);
      const id = existingId || randomUUID();
      const now = new Date().toISOString();
      const previous = db.profiles[id] || {};
      const quantities = normalizeQuantities(payload.quantities);
      if (!Object.keys(quantities).length) {
        return json(res, 400, { error: "empty_quantities" });
      }

      const profile = {
        id,
        ownerId: authUser?.id || previous.ownerId || "",
        user: cleanText(authUser?.displayName || payload.user || previous.user || "Sin usuario", 80),
        source: cleanText(payload.source || previous.source || "manager", 32),
        app: cleanText(payload.app || previous.app || "digital-panini-2026-manager", 80),
        exportedAt: cleanText(payload.exportedAt || now, 40),
        createdAt: previous.createdAt || now,
        updatedAt: now,
        quantities
      };

      db.profiles[id] = profile;
      await writeDb(db);
      log("profile:upsert", {
        requestId,
        profileId: id,
        ownerId: profile.ownerId,
        user: profile.user,
        source: profile.source,
        quantityCount: Object.keys(quantities).length
      });
      return json(res, 200, { profile: publicProfile(profile) });
    }

    return json(res, 404, { error: "not_found" });
  } catch (error) {
    log("request:error", {
      requestId,
      method: req.method,
      path: urlForLog.pathname,
      message: error.message,
      stack: error.stack
    }, "error");
    return json(res, 500, { error: "internal_error", message: error.message });
  }
});

server.listen(port, () => {
  log("server:start", { port, url: `http://localhost:${port}`, fileLogsEnabled });
});

server.on("error", (error) => {
  log("server:error", { message: error.message, stack: error.stack }, "error");
});

async function readDb() {
  try {
    const text = (await readFile(dbPath, "utf8")).replace(/^\uFEFF/, "");
    const data = JSON.parse(text);
    return {
      profiles: data.profiles && typeof data.profiles === "object" ? data.profiles : {},
      users: data.users && typeof data.users === "object" ? data.users : {}
    };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { profiles: {}, users: {} };
  }
}

async function writeDb(db) {
  await mkdir(dataDir, { recursive: true });
  await writeFile(dbPath, `${JSON.stringify(db, null, 2)}\n`, "utf8");
}

function publicProfile(profile) {
  return {
    id: profile.id,
    ownerId: profile.ownerId || "",
    user: profile.user,
    source: profile.source,
    app: profile.app,
    exportedAt: profile.exportedAt,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
    quantities: profile.quantities
  };
}

function createUser(username, password, displayName) {
  const salt = randomBytes(16).toString("hex");
  return {
    id: randomUUID(),
    username,
    displayName: displayName || username,
    salt,
    passwordHash: hashPassword(password, salt),
    createdAt: new Date().toISOString()
  };
}

function authPayload(user) {
  return {
    token: userToken(user),
    user: publicUser(user)
  };
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName
  };
}

function userFromRequest(req, db) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) return null;
  return Object.values(db.users).find((user) => userToken(user) === token) || null;
}

function requireUser(req, res, db) {
  const user = userFromRequest(req, db);
  if (!user) {
    json(res, 401, { error: "login_required" });
    return null;
  }
  return user;
}

function userToken(user) {
  return createHash("sha256").update(`${user.id}:${user.passwordHash}`).digest("hex");
}

function hashPassword(password, salt) {
  return createHash("sha256").update(`${salt}:${password}`).digest("hex");
}

function cleanUsername(value) {
  return cleanText(value, 40).toLowerCase().replace(/[^a-z0-9._-]/g, "");
}

function normalizeQuantities(input) {
  const quantities = {};
  for (const [rawCode, rawValue] of Object.entries(input || {})) {
    const code = cleanText(rawCode, 80).toUpperCase().replace(/\s+/g, " ").trim();
    const value = Math.max(0, Math.floor(Number(rawValue) || 0));
    if (code && value > 0) quantities[code] = value;
  }
  return quantities;
}

function cleanId(value) {
  const id = cleanText(value, 100);
  return /^[a-zA-Z0-9._:-]{3,100}$/.test(id) ? id : "";
}

function cleanText(value, max) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, max).trim();
}

function safeQuery(url) {
  const entries = {};
  for (const [key, value] of url.searchParams) {
    entries[key] = key.toLowerCase().includes("token") || key.toLowerCase().includes("password") ? "[redacted]" : value;
  }
  return entries;
}

function log(event, details = {}, level = "info") {
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...details
  };
  const line = JSON.stringify(entry);
  const writer = level === "error" ? console.error : console.log;
  writer(line);
  if (!fileLogsEnabled) return;
  mkdir(logsDir, { recursive: true })
    .then(() => appendFile(logPath, `${line}\n`, "utf8"))
    .catch((error) => console.error(JSON.stringify({
      ts: new Date().toISOString(),
      level: "error",
      event: "log:write_failed",
      message: error.message
    })));
}

async function readJsonBody(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 4_000_000) throw new Error("body_too_large");
  }
  return raw ? JSON.parse(raw) : {};
}

function json(res, status, body) {
  send(res, status, JSON.stringify(body, null, 2), {
    "Content-Type": "application/json; charset=utf-8"
  });
}

function send(res, status, body = "", headers = {}) {
  res.writeHead(status, { ...corsHeaders, ...headers });
  res.end(body);
}
