import { headers } from "next/headers";
import { getAuth } from "./auth";

export async function getSession() {
  return getAuth().api.getSession({ headers: await headers() });
}

/** For route handlers that take a Request instead of reading next/headers. */
export function getSessionFor(request: Request) {
  return getAuth().api.getSession({ headers: request.headers });
}
