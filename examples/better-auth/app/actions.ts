"use server";
import { revalidatePath } from "next/cache";
import { getBexio, isWorkspaceOwner } from "@/lib/bexio";
import { getSession } from "@/lib/session";

export async function disconnect(formData: FormData) {
  const session = await getSession();
  const ownerId = String(formData.get("ownerId"));
  const grantId = String(formData.get("grantId"));
  // Only the user's own grant or a demo workspace.
  if (!session || (ownerId !== session.user.id && !isWorkspaceOwner(ownerId))) {
    throw new Error("Not allowed");
  }
  await getBexio().disconnect({ ownerId, grantId });
  revalidatePath("/");
}
