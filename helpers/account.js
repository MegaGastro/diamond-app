export const loginAPI = async ({ email, password, store }) => {
  const login_api_url = process.env[`${store}_LOGIN_API`];
  if(!login_api_url)return null;

  const access_token = await fetch(login_api_url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      email,
      password
    })
  }).then(result=>result.json()).then(data=>{
    return data.access_token
  });

  if(!access_token)return null;

  return access_token;
};