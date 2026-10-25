"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getBexio } from "@/lib/bexio";
import { env } from "@/lib/env";
import { createClient, getUser } from "@/lib/supabase/server";

export async function signUpOrIn(formData: FormData) {
  const supabase = await createClient();
  const email = String(formData.get("email"));
  const password = String(formData.get("password"));
  const signIn = await supabase.auth.signInWithPassword({ email, password });
  if (signIn.error) {
    // Local stack: email confirmation is off, so sign-up signs the user in.
    const signUp = await supabase.auth.signUp({ email, password });
    if (signUp.error)
      redirect(`/?auth_error=${encodeURIComponent(signUp.error.message)}`);
  }
  redirect("/");
}

export async function signInWithBexio() {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: env("BEXIO_SUPABASE_PROVIDER") as `custom:${string}`,
    options: { redirectTo: `${env("APP_URL")}/auth/callback` },
  });
  if (error || !data.url) redirect("/?auth_error=oauth_start_failed");
  redirect(data.url);
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/");
}

export async function disconnect(formData: FormData) {
  const user = await getUser();
  if (!user) throw new Error("Not signed in");
  await getBexio().disconnect({
    ownerId: user.id,
    grantId: String(formData.get("grantId")),
  });
  revalidatePath("/");
}
