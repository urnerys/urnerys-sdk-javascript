export function githubBuildId(): string | undefined {
  const { GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT } = process.env;
  return GITHUB_RUN_ID && GITHUB_RUN_ATTEMPT ? `github-run-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}` : undefined;
}

export function githubCommit(): string | undefined {
  return process.env.GITHUB_SHA;
}

/**
 * Requests an OIDC token for the given audience from GitHub Actions.
 * Returns `undefined` when the job has no `id-token: write` permission.
 */
export async function fetchGithubOidcToken(audience: string): Promise<string | undefined> {
  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;

  if (!requestUrl || !requestToken) {
    return undefined;
  }

  const url = new URL(requestUrl);
  url.searchParams.set("audience", audience);

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${requestToken}` },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch OIDC token: ${response.status}`);
  }

  const { value } = (await response.json()) as { value: string };
  return value;
}
