import { createTRPCClient, httpLink } from "@trpc/client";
import type { AppRouter } from "api/router";

/** 開発用 API の URL(例: http://192.168.0.10:3000)。実機からは PC の LAN IP を指定する */
const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:3000";

export const api = createTRPCClient<AppRouter>({
  links: [httpLink({ url: `${API_URL}/trpc` })],
});
