"use server";
import { revalidatePath } from "next/cache";
import { canManageOwner, getBexio } from "@/lib/bexio";
import { getSession } from "@/lib/session";

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
