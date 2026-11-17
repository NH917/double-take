const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const sizeOf = require('probe-image-size');
const actions = require('./actions');
const { DETECTORS } = require('../../constants')();
const config = require('../../constants/config');

const { FRIGATE } = DETECTORS || {};

const DEFAULT_COOKIE_NAME = 'frigate_token';

let cachedToken = null;

const isConfigured = () => Boolean(FRIGATE?.URL);

const requestTimeout = () => (FRIGATE?.TIMEOUT || 15) * 1000;

const extractTokenFromCookies = (setCookieHeader, cookieName = DEFAULT_COOKIE_NAME) => {
  const cookies = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const cookie of cookies.filter(Boolean)) {
    for (const part of cookie.split(';')) {
      const trimmed = part.trim();
      if (trimmed.startsWith(`${cookieName}=`)) {
        return trimmed.slice(cookieName.length + 1);
      }
    }
  }
  return null;
};

const login = async () => {
  const { URL, USERNAME, PASSWORD, COOKIE_NAME } = FRIGATE;
  if (!USERNAME || !PASSWORD) return null;

  const response = await axios({
    method: 'post',
    url: `${URL}/api/login`,
    timeout: requestTimeout(),
    headers: { 'Content-Type': 'application/json' },
    data: { user: USERNAME, password: PASSWORD },
    validateStatus() {
      return true;
    },
  });

  if (response.status >= 400) {
    throw new Error(
      `frigate login failed: ${response.status} ${JSON.stringify(response.data || {})}`
    );
  }

  const token = extractTokenFromCookies(response.headers['set-cookie'], COOKIE_NAME || DEFAULT_COOKIE_NAME);
  if (!token) throw new Error('frigate login failed: missing frigate_token cookie');
  cachedToken = token;
  return token;
};

const authHeaders = async ({ forceLogin = false } = {}) => {
  if (FRIGATE?.TOKEN) return { Authorization: `Bearer ${FRIGATE.TOKEN}` };
  if (!forceLogin && cachedToken) return { Authorization: `Bearer ${cachedToken}` };
  if (FRIGATE?.USERNAME && FRIGATE?.PASSWORD) {
    const token = await login();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }
  return {};
};

const withAuthRetry = async (requestFactory) => {
  const headers = await authHeaders();
  let response = await requestFactory(headers);
  if (response.status === 401 && FRIGATE?.USERNAME && FRIGATE?.PASSWORD && !FRIGATE?.TOKEN) {
    cachedToken = null;
    const refreshed = await authHeaders({ forceLogin: true });
    response = await requestFactory(refreshed);
  }
  return response;
};

const faceName = (name) => encodeURIComponent(String(name).replace(/ /g, '_'));

module.exports.recognize = async ({ key, test }) => {
  if (!isConfigured()) return { status: 500, data: 'frigate detector not configured' };

  if (test) {
    return withAuthRetry((headers) =>
      axios({
        method: 'get',
        url: `${FRIGATE.URL}/api/faces`,
        timeout: requestTimeout(),
        headers,
        validateStatus() {
          return true;
        },
      })
    );
  }

  const { width, height } = await sizeOf(fs.createReadStream(key)).catch(() => ({
    width: 0,
    height: 0,
  }));

  // Build FormData inside the retry factory so a 401 retry gets a fresh stream.
  const response = await withAuthRetry((headers) => {
    const formData = new FormData();
    formData.append('file', fs.createReadStream(key));
    return axios({
      method: 'post',
      url: `${FRIGATE.URL}/api/faces/recognize`,
      timeout: requestTimeout(),
      headers: {
        ...formData.getHeaders(),
        ...headers,
      },
      validateStatus() {
        return true;
      },
      data: formData,
    });
  });

  return {
    ...response,
    data: {
      ...(response.data || {}),
      source: { width, height },
    },
  };
};

module.exports.train = async ({ name, key }) => {
  if (!isConfigured()) return { status: 500, data: { success: false, message: 'frigate detector not configured' } };

  const encodedName = faceName(name);

  await withAuthRetry((headers) =>
    axios({
      method: 'post',
      url: `${FRIGATE.URL}/api/faces/${encodedName}/create`,
      timeout: requestTimeout(),
      headers,
      validateStatus() {
        return true;
      },
    })
  );

  return withAuthRetry((headers) => {
    const formData = new FormData();
    formData.append('file', fs.createReadStream(key));
    return axios({
      method: 'post',
      url: `${FRIGATE.URL}/api/faces/${encodedName}/register`,
      timeout: requestTimeout(),
      headers: {
        ...formData.getHeaders(),
        ...headers,
      },
      validateStatus() {
        return true;
      },
      data: formData,
    });
  });
};

module.exports.remove = async ({ name }) => {
  if (!isConfigured()) return { status: 500, data: { success: false, message: 'frigate detector not configured' } };

  const encodedName = faceName(name);
  const facesResponse = await withAuthRetry((headers) =>
    axios({
      method: 'get',
      url: `${FRIGATE.URL}/api/faces`,
      timeout: requestTimeout(),
      headers,
      validateStatus() {
        return true;
      },
    })
  );

  if (facesResponse.status >= 400) return facesResponse;

  const ids =
    facesResponse.data?.[name] ||
    facesResponse.data?.[String(name).replace(/ /g, '_')] ||
    facesResponse.data?.[encodedName] ||
    [];

  if (!ids.length) {
    return { status: 200, data: { success: true, message: 'no frigate faces to delete' } };
  }

  return withAuthRetry((headers) =>
    axios({
      method: 'post',
      url: `${FRIGATE.URL}/api/faces/${encodedName}/delete`,
      timeout: requestTimeout(),
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      validateStatus() {
        return true;
      },
      data: { ids },
    })
  );
};

module.exports.normalize = ({ camera, data }) => {
  if (!data || typeof data !== 'object' || data.success === false) {
    if (data?.message) console.warn(`frigate recognize: ${data.message}`);
    return [];
  }

  const { MATCH, UNKNOWN } = config.detect(camera);
  const score = typeof data.score === 'number' ? data.score : 0;
  const confidence = parseFloat((score * 100).toFixed(2));
  const rawName = data.face_name || 'unknown';
  const isUnknown = !data.face_name || rawName.toLowerCase() === 'unknown';
  const width = data.source?.width || 0;
  const height = data.source?.height || 0;
  const box = {
    top: 0,
    left: 0,
    width,
    height,
  };
  const area = width * height;
  const output = {
    name: !isUnknown && confidence >= UNKNOWN.CONFIDENCE ? String(rawName).toLowerCase() : 'unknown',
    confidence,
    match:
      !isUnknown &&
      confidence >= MATCH.CONFIDENCE &&
      (area === 0 || area >= MATCH.MIN_AREA),
    box,
  };
  const checks = actions.checks({ MATCH, UNKNOWN, ...output });
  if (checks.length) output.checks = checks;
  return checks !== false ? [output] : [];
};
