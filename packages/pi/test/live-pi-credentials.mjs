export function resolveLiveCredentials(env) {
  const parentKey = env.OPENCODE_API_KEY;
  if (!parentKey) throw new Error('Set OPENCODE_API_KEY to run the live Pi delegation check.');
  return {
    parentKey,
    childKey: env.SUBZERO_TEST_KEY || parentKey,
  };
}
