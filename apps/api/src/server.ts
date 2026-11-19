import { randomUUID } from "node:crypto";
import { createHTTPServer } from "@trpc/server/adapters/standalone";
import { loadConfig } from "./config.js";
import { appRouter } from "./router.js";
import { createServices } from "./services.js";

const port = Number(process.env.PORT ?? 3000);
const config = loadConfig();
const services = createServices(config);

createHTTPServer({
  basePath: "/trpc/",
  router: appRouter,
  createContext: ({ req }) => {
    const header = req.headers.authorization;
    const accessToken = header?.startsWith("Bearer ") ? header.slice(7) : null;
    return { requestId: randomUUID(), services, accessToken, ip: req.socket.remoteAddress ?? null };
  },
}).listen(port);

// eslint-disable-next-line no-console -- 起動ログ(個人情報なし)
console.log(`api listening on :${port}${services ? "" : "(DATABASE_URL 未設定: 認証が必要な API は使えません)"}`);
