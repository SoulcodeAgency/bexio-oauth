"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { idleFor } from "@/lib/cron";
import { canManageOwner, getBexio } from "@/lib/bexio";
import { getSession } from "@/lib/session";
import {
  expireAccessToken,
  revokeCurrentToken,
  revokeSavedToken,
  saveToken,
  testToolsEnabled,
} from "@/lib/test-tools";

const text = (value: FormDataEntryValue | null) =>
  typeof value === "string" ? value : "";

export async function disconnect(formData: FormData) {
  const session = await getSession();
  const ownerId = text(formData.get("ownerId"));
  const grantId = text(formData.get("grantId"));
  if (!canManageOwner(session?.user, ownerId)) throw new Error("Not allowed");
  await getBexio().disconnect({ ownerId, grantId });
  revalidatePath("/");
}

const TEST_TOOLS = {
  expire: expireAccessToken,
  revoke: revokeCurrentToken,
  save: saveToken,
  "revoke-saved": revokeSavedToken,
};

/** Test tools for live Bexio accounts (lib/test-tools.ts); on unless BEXIO_TEST_TOOLS=off. */
export async function testTool(formData: FormData) {
  if (!testToolsEnabled()) throw new Error("Test tools are off");
  const session = await getSession();
  const ownerId = text(formData.get("ownerId"));
  const connectionId = text(formData.get("connectionId"));
  const tool = text(formData.get("tool"));
  if (!canManageOwner(session?.user, ownerId)) throw new Error("Not allowed");
  // Only a connection this owner has a grant on.
  const grants = await getBexio().listGrants({ ownerId });
  if (!grants.some((g) => g.connectionId === connectionId))
    throw new Error("Not allowed");
  if (!Object.hasOwn(TEST_TOOLS, tool)) throw new Error("Unknown tool");
  await TEST_TOOLS[tool as keyof typeof TEST_TOOLS](connectionId);
  revalidatePath("/");
}

/** Test tool: runs what the refreshIdle cron runs, and shows the result. */
export async function runRefreshIdle() {
  if (!testToolsEnabled()) throw new Error("Test tools are off");
  if (!(await getSession())) throw new Error("Not signed in");
  const result = await getBexio().refreshIdle({ idleFor: idleFor() });
  redirect(`/?refresh_idle=${encodeURIComponent(JSON.stringify(result))}`);
}
