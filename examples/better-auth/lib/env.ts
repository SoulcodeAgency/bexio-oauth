/** Required server-side env var; read at request time, never during `next build`. */
export function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (see .env.example)`);
  return value;
}

export const optionalEnv = (name: string) => process.env[name] || undefined;
