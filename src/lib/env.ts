export function getRequiredEnv(
  name: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const value = env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}
