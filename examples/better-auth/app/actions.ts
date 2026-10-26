"use server";
import { revalidatePath } from "next/cache";
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

/** The live checklist's test tools (lib/test-tools.ts); off unless BEXIO_TEST_TOOLS=on. */
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
