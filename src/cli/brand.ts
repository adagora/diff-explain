const aliases = [
  ["MEAT_MODEL", "THREAD_MODEL", "COLUMBO_MODEL"],
  ["MEAT_CACHE", "THREAD_CACHE", "COLUMBO_CACHE"],
] as const;

export function applyColumboEnvironment(env: NodeJS.ProcessEnv): void {
  for (const [legacy, ...preferred] of aliases) {
    for (const key of preferred) {
      const value = env[key];
      if (value !== undefined) env[legacy] = value;
    }
  }
}
