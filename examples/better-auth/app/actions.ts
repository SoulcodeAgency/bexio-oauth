"use server";
import { revalidatePath } from "next/cache";
import { canManageOwner, getBexio } from "@/lib/bexio";
import { getSession } from "@/lib/session";

export async function disconnect(formData: FormData) {
  const session = await getSession();
  const ownerId = String(formData.get("ownerId"));
  const grantId = String(formData.get("grantId"));
  if (!canManageOwner(session?.user, ownerId)) throw new Error("Not allowed");
  await getBexio().disconnect({ ownerId, grantId });
  revalidatePath("/");
}
