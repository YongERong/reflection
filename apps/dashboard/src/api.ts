const dashboardApiBaseUrl = import.meta.env.VITE_DASHBOARD_API_URL ?? "http://localhost:8787";

export async function fetchDashboardData<T>(): Promise<T> {
  const response = await fetch(`${dashboardApiBaseUrl}/api/dashboard`);

  if (!response.ok) {
    const errorBody = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(errorBody?.error ?? `Dashboard API returned ${response.status}`);
  }

  return (await response.json()) as T;
}
