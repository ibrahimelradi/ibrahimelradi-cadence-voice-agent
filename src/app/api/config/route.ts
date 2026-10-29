import { connection } from "next/server";
import { capabilities } from "@/lib/server/env";

/** Which providers are configured on the server. Never returns secrets. */
export async function GET() {
  await connection(); // evaluate per request, never at build time
  return Response.json(capabilities(), { headers: { "Cache-Control": "no-store" } });
}
