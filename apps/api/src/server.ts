import { randomUUID } from "node:crypto";
import { createHTTPServer } from "@trpc/server/adapters/standalone";
import { appRouter } from "./router.js";

const port = Number(process.env.PORT ?? 3000);

createHTTPServer({
  basePath: "/trpc/",
  router: appRouter,
  createContext: () => ({ requestId: randomUUID() }),
}).listen(port);

// eslint-disable-next-line no-console -- 起動ログ(個人情報なし)
console.log(`api listening on :${port}`);
