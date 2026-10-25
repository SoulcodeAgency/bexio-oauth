"use client";
import { authClient } from "@/lib/auth-client";

export function SignInWithBexio() {
  return (
    <button
      data-testid="sign-in"
      onClick={() =>
        authClient.signIn.social({ provider: "bexio", callbackURL: "/" })
      }
    >
      Sign in with Bexio
    </button>
  );
}

export function SignOut() {
  return (
    <button
      data-testid="sign-out"
      onClick={() => authClient.signOut().then(() => location.assign("/"))}
    >
      Sign out
    </button>
  );
}
