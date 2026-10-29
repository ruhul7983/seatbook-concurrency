// fetch, but a 401 means the session is gone: clear it and send the user to sign in.
// Only for requests that send a token; a 401 from login means a wrong password, not an expired session.
export async function apiFetch(input: string, init?: RequestInit) {
  const res = await fetch(input, init);
  if (res.status === 401) {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.location.href = '/login';
  }
  return res;
}
