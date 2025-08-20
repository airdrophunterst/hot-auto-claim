const fs = require("fs");
const path = require("path");
const axios = require("axios");
const colors = require("colors");
const { HttpsProxyAgent } = require("https-proxy-agent");
const readline = require("readline");
const user_agents = require("./config/userAgents");
const settings = require("./config/config");
const { sleep, loadData, getRandomNumber, saveToken, isTokenExpired, saveJson } = require("./utils/utils");
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");
const { checkBaseUrl } = require("./checkAPI");
const { connect, keyStores, KeyPair, Contract } = require("near-api-js");
const moment = require("moment");
const XLSX = require("xlsx");
const querystring = require("querystring");
const BigNumber = require("bignumber.js");
const nacl = require("tweetnacl");
const { v4: uuid } = require("uuid");
const { jwtDecode } = require("jwt-decode");
const Base58 = require("bs58").default;

const mainnetConfig = {
  networkId: "mainnet",
  nodeUrl: "https://rpc.mainnet.near.org",
  walletUrl: "https://wallet.mainnet.near.org",
  helperUrl: "https://helper.mainnet.near.org",
};
class ClientAPI {
  constructor(itemData, accountIndex, proxy, baseURL) {
    this.headers = {
      Accept: "*/*",
      "Accept-Encoding": "gzip, deflate, br",
      "Accept-Language": "vi-VN,vi;q=0.9,fr-FR;q=0.8,fr;q=0.7,en-US;q=0.6,en;q=0.5",
      "Content-Type": "application/json",
      // origin: "chrome-extension://mpeengabcnhhjjgleiodimegnkpcenbk",
      // referer: "https://tgapp.herewallet.app/",
      "Sec-Ch-Ua": '"Not/A)Brand";v="99", "Google Chrome";v="115", "Chromium";v="115"',
      "Sec-Ch-Ua-Mobile": "?0",
      "Sec-Ch-Ua-Platform": '"Windows"',
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36",
    };
    this.baseURL = baseURL;
    this.itemData = itemData;
    this.accountIndex = accountIndex;
    this.proxy = proxy;
    this.proxyIP = null;
    this.session_name = null;
    this.session_user_agents = this.#load_session_data();
    this.token = null;
    this.wallet = null;
    this.accountId = null;
  }

  #load_session_data() {
    try {
      const filePath = path.join(process.cwd(), "session_user_agents.json");
      const data = fs.readFileSync(filePath, "utf8");
      return JSON.parse(data);
    } catch (error) {
      if (error.code === "ENOENT") {
        return {};
      } else {
        throw error;
      }
    }
  }

  #get_random_user_agent() {
    const randomIndex = Math.floor(Math.random() * user_agents.length);
    return user_agents[randomIndex];
  }

  #get_user_agent() {
    if (this.session_user_agents[this.session_name]) {
      return this.session_user_agents[this.session_name];
    }

    const newUserAgent = this.#get_random_user_agent();
    this.session_user_agents[this.session_name] = newUserAgent;
    this.#save_session_data(this.session_user_agents);
    return newUserAgent;
  }

  #save_session_data(session_user_agents) {
    const filePath = path.join(process.cwd(), "session_user_agents.json");
    fs.writeFileSync(filePath, JSON.stringify(session_user_agents, null, 2));
  }

  #get_platform(userAgent) {
    const platformPatterns = [
      { pattern: /iPhone/i, platform: "ios" },
      { pattern: /Android/i, platform: "android" },
      { pattern: /iPad/i, platform: "ios" },
    ];

    for (const { pattern, platform } of platformPatterns) {
      if (pattern.test(userAgent)) {
        return platform;
      }
    }

    return "Android";
  }

  #set_headers() {
    const platform = this.#get_platform(this.#get_user_agent());
    this.headers["sec-ch-ua"] = `Not)A;Brand";v="99", "${platform} WebView";v="127", "Chromium";v="127`;
    this.headers["sec-ch-ua-platform"] = platform;
    this.headers["User-Agent"] = this.#get_user_agent();
  }

  createUserAgent() {
    try {
      this.session_name = this.itemData.accountId;
      this.#get_user_agent();
    } catch (error) {
      this.log(`Can't create user agent, try get new query_id: ${error.message}`, "error");
      return;
    }
  }

  async log(msg, type = "info") {
    const accountPrefix = `[Hot][${this.accountIndex + 1}]`;
    let ipPrefix = this.proxyIP ? `[${this.proxyIP}]` : "[Local IP]";
    let logMessage = "";
    if (settings.USE_PROXY) {
      ipPrefix = this.proxyIP ? `[${this.proxyIP}]` : "[Unknown IP]";
    }
    switch (type) {
      case "success":
        logMessage = `${accountPrefix}${ipPrefix} ${msg}`.green;
        break;
      case "error":
        logMessage = `${accountPrefix}${ipPrefix} ${msg}`.red;
        break;
      case "warning":
        logMessage = `${accountPrefix}${ipPrefix} ${msg}`.yellow;
        break;
      case "custom":
        logMessage = `${accountPrefix}${ipPrefix} ${msg}`.magenta;
        break;
      default:
        logMessage = `${accountPrefix}${ipPrefix} ${msg}`.blue;
    }
    console.log(logMessage);
  }

  async checkProxyIP() {
    try {
      const proxyAgent = new HttpsProxyAgent(this.proxy);
      const response = await axios.get("https://api.ipify.org?format=json", { httpsAgent: proxyAgent });
      if (response.status === 200) {
        this.proxyIP = response.data.ip;
        return response.data.ip;
      } else {
        throw new Error(`Cannot check proxy IP. Status code: ${response.status}`);
      }
    } catch (error) {
      throw new Error(`Error checking proxy IP: ${error.message}`);
    }
  }

  async makeRequest(
    url,
    method,
    data = {},
    options = {
      retries: 1,
      isAuth: false,
      extraHeaders: {},
    }
  ) {
    const initOptions = {
      retries: 2,
      isAuth: false,
      extraHeaders: {},
      ...options,
    };
    const { retries, isAuth, extraHeaders } = initOptions;

    const headers = {
      ...this.headers,
      ...extraHeaders,
      Deviceid: this.device_id,
      "Device-id": this.device_id,
    };

    if (!isAuth) {
      headers["authorization"] = `${this.token}`;
      // headers["telegram-data"] = "";
    }

    let proxyAgent = null;
    if (settings.USE_PROXY) {
      proxyAgent = new HttpsProxyAgent(this.proxy);
    }
    let currRetries = 0,
      success = false;
    do {
      try {
        const response = await axios({
          method,
          url: `${url}`,
          data,
          headers,
          timeout: 30000,

          ...(proxyAgent ? { httpsAgent: proxyAgent, httpAgent: proxyAgent } : {}),
        });
        success = true;
        return { status: response.status, success: true, data: response.data?.data || response.data };
      } catch (error) {
        console.log(error.response?.data?.detail);
        if (error.status == 401) {
          const token = await this.getValidToken(true);
          if (!token) {
            process.exit(0);
          }
          this.token = token;
          if (retries > 0)
            return await this.makeRequest(url, method, data, {
              ...options,
              retries: 0,
            });
          else return { success: false, status: error.status, error: error.response.data || error.message };
        }
        if (error.status == 400) {
          return { success: false, status: error.status, error: error.response.data || error.message };
        }
        success = false;
        await sleep(settings.DELAY_BETWEEN_REQUESTS);
        if (currRetries == retries) return { status: error.status, success: false, error: error.message };
      }
      currRetries++;
    } while (currRetries <= retries && !success);
  }

  async auth() {
    // const message = "web_wallet";
    // const nonce = [113, 97, 11, 61, 71, 133, 146, 127, 74, 44, 232, 198, 198, 168, 17, 141, 90, 94, 90, 111, 252, 246, 215, 217, 238, 91, 87, 118, 102, 100, 58, 203];
    // const messageBytes = new TextEncoder().encode(message);
    // const nonceBytes = new Uint8Array(nonce);
    // const fullMessage = new Uint8Array([...messageBytes, ...nonceBytes]);
    // const keyPair = KeyPair.fromString(this.itemData.privateKey.trim());
    // let signature;
    // const secretKey = keyPair.secretKey;
    // try {
    //   // signature = nacl.sign.detached(fullMessage, secretKey);
    // } catch (error) {
    //   console.error("Error signing message:", error);
    //   throw new Error("Failed to sign message");
    // }
    // const account_sign = keyPair.sign(fullMessage).signature.toString("base64");
    // // Buffer.from(signature).toString("base64");
    // console.log({
    //   fullMessage: fullMessage.toString(),
    //   keyPair: "",
    //   pub: keyPair.getPublicKey().toString(),
    //   sign: account_sign,
    // });
    // await sleep(1);
    // const payload = {
    //   ref_code: "",
    //   imported: true,
    //   public_key: keyPair.getPublicKey().toString(),
    //   near_account_id: this.itemData.accountId,
    //   device_name: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
    //   device_id: uuid(),
    //   account_sign: account_sign,
    //   recapcha_response: "",
    //   msg: "web_wallet",
    //   nonce: nonce,
    // };
    // return this.makeRequest(`${this.baseURL}/user/auth`, "post", payload, { isAuth: true });
  }

  async getAccId() {
    const keyPair = KeyPair.fromString(this.itemData.privateKey.trim());
    return this.makeRequest(`https://api.fastnear.com/v0/public_key/${keyPair.getPublicKey()}`, "get", null, { isAuth: true });
  }

  async getUserInfo() {
    const accountConnection = await this.getAccount();
    const contract = new Contract(accountConnection, "game.hot.tg", {
      viewMethods: ["get_user"],
      changeMethods: ["claim"],
      useLocalViewExecution: false,
    });

    const [user] = await Promise.all([
      contract.get_user({
        account_id: this.itemData.accountId,
      }),
    ]);
    return user;
  }

  async getClaimStatus(last_claim) {
    return this.makeRequest(
      `${this.baseURL}/user/hot/claim/status`,
      "post",
      {
        game_state: {
          refferals: 0,
          inviter: "nguyenhung2310.tg",
          village: "439885.village.hot.tg",
          last_claim: last_claim || null,
          firespace: 0,
          boost: 10,
          storage: 20,
          balance: 24845,
        },
      },
      {
        extraHeaders: {
          Origin: "chrome-extension://mpeengabcnhhjjgleiodimegnkpcenbk",
          Platform: "chrome-extension",
          "is-sbt": false,
        },
      }
    );
  }

  async checkFollowTele() {
    return this.makeRequest(`${this.baseURL}/user/hot/follow_tg`, "get");
  }

  async claimHotFree() {
    return this.makeRequest(`${this.baseURL}/user/hot/claim`, "post", {
      game_state: {
        last_claim: Date.now(),
        refferals: 0,
        inviter: "nguyenhung2310.tg",
        village: "439885.village.hot.tg",
        firespace: 0,
        boost: 10,
        storage: 20,
        balance: 0,
      },
    });
  }

  async freeAccount() {
    return this.makeRequest(`${this.baseURL}/user/hot/freeze_account`, "post", {
      accountId: this.itemData.accountId,
    });
  }

  async getMission() {
    return this.makeRequest(`${this.baseURL}/user/hot/missions`, "get");
  }

  async getGas() {
    return this.makeRequest(`${this.baseURL}/user/hot/gas_free`, "get");
  }

  async getSignatureClaim() {
    return this.makeRequest(`${this.baseURL}/user/hot/claim/signature`, "post", {
      game_state: {
        last_claim: Date.now(),
        refferals: 0,
        inviter: "nguyenhung2310.tg",
        village: "439885.village.hot.tg",
        firespace: 0,
        boost: 10,
        storage: 20,
        balance: 0,
      },
    });
  }

  async handleUpgrade() {
    const hot = await this.getHotBalance();
    const res = await this.getGas();
    if (!res.success) return this.log(`Can't get gas free | ${JSON.stringify(res)}`, "error");
    const gas = (parseInt(res.data.amount) / 1_000_000).toFixed(6);
    if (gas > hot) {
      this.log(`Not enough gas | ${gas} < ${hot} to upgrade`, "warning");
      return;
    }
  }

  async getValidToken(isNew = false) {
    const existingToken = this.token;
    const isExp = isTokenExpired(existingToken);
    if (existingToken && !isNew && !isExp) {
      this.log("Using valid token", "success");
      return existingToken;
    } else {
      this.log("No found token or experied, trying get new token...", "warning");

      const newToken = await this.auth();
      if (newToken.success && newToken.data?.token) {
        this.token = res.data.token;
        await saveJson(this.session_name, res.data.token, "tokens.json");
        return res.data.token;
      }
      this.log("Can't get new token...", "warning");
      return null;
    }
  }

  async getAccount() {
    const accountId = this.itemData.accountId,
      privateKey = this.itemData.privateKey;
    try {
      const keyStore = new keyStores.InMemoryKeyStore();
      const keyPair = KeyPair.fromString(privateKey);
      await keyStore.setKey(mainnetConfig.networkId, accountId, keyPair);

      const connectionConfig = {
        deps: {
          keyStore,
        },
        ...mainnetConfig,
      };

      const accountConnection = await connect(connectionConfig);
      const account = await accountConnection.account(accountId);
      return account;
    } catch (error) {
      console.error(`Error getting account: ${error.message}`);
      throw error;
    }
  }

  async getHotBalance() {
    const accountId = this.itemData.accountId;
    try {
      const balance = await this.wallet.viewFunction({
        contractId: "game.hot.tg",
        methodName: "ft_balance_of",
        args: { account_id: accountId },
      });
      const balanceFormatted = (parseInt(balance) / 1_000_000).toFixed(6);
      return balanceFormatted;
    } catch (error) {
      this.log(`[${accountId}] Error fetching HOT balance: ${error.message}`);
      return 0;
    }
  }

  async getNearBalance() {
    const accountId = this.itemData.accountId,
      privateKey = this.itemData.privateKey;
    const account = await this.getAccount(accountId, privateKey);
    const NearBalance = await account.getAccountBalance();
    return new BigNumber(NearBalance.total).dividedBy(1e24);
  }

  async handleClaim() {
    const ACCOUNT_ID = this.itemData.accountId;
    try {
      this.log(`[${moment().format("HH:mm:ss")}] Claiming onchain`);
      const callContract = await this.wallet.functionCall({
        contractId: "game.hot.tg",
        methodName: "claim",
        args: {},
      });
      const hash = callContract.transaction.hash;
      this.log(`Claimed HOT for ${ACCOUNT_ID}\nTx: https://nearblocks.io/id/txns/${hash}`, "success");
    } catch (error) {
      this.log(`[${ACCOUNT_ID}] Error claim hot: ${error.message}`, "warning");
    }
  }

  async handleClaimFree() {
    const res = await this.checkFollowTele();
    if (!res.success) return this.log(`Can't check status follow tele | ${JSON.stringify(res)}`, "error");
    if (res.data?.follow_tg_channel) {
      const resClaimFree = await this.claimHotFree();
      if (resClaimFree.success) {
        this.log(`Claim HOT Free success`, "success");
      } else {
        this.log(`Claim HOT Free failed | ${JSON.stringify(resClaimFree)}`, "error");
        if (JSON.stringify(resClaimFree).includes("Account already registered on other device")) {
          this.log(`Account already registered on other device, freezing account`, "warning");
          const resFreeze = await this.freeAccount();
          if (resFreeze.success) {
            this.log(`Account frozen successfully`, "success");
            return await this.handleClaimFree();
          } else {
            this.log(`Failed to freeze account | ${JSON.stringify(resFreeze)}`, "error");
          }
        }
      }
    } else {
      this.log(`Account need follow telegram HOT to claim free`, "warning");
    }
    return;
  }

  async connectRPC() {
    const PRIVATE_KEY = this.itemData.privateKey.trim();
    const ACCOUNT_ID = this.itemData.accountId.trim();
    const myKeyStore = new keyStores.InMemoryKeyStore();
    const keyPair = KeyPair.fromString(PRIVATE_KEY);
    await myKeyStore.setKey("mainnet", ACCOUNT_ID, keyPair);
    const connection = await connect({
      networkId: "mainnet",
      nodeUrl: "https://rpc.mainnet.near.org",
      keyStore: myKeyStore,
      walletUrl: "https://wallet.mainnet.near.org",
      headers: {}, // Optional: Add headers if needed for custom RPC
      ...(settings.USE_PROXY
        ? {
            deps: {
              http: () => ({
                get: (url, options) => axios.get(url, { ...options, httpsAgent: proxyAgent }),
                post: (url, data, options) => axios.post(url, data, { ...options, httpsAgent: proxyAgent }),
              }),
            },
          }
        : {}),
    });

    const wallet = await connection.account(ACCOUNT_ID);
    this.wallet = wallet;
  }

  timeLeft(timeLeft) {
    const hoursLeft = Math.floor(timeLeft / 3600);
    const minutesLeft = Math.floor((timeLeft % 3600) / 60);
    const secondsLeft = Math.floor(timeLeft % 60);
    this.log(`⏳ Time left until next claim: ${hoursLeft}h ${minutesLeft}m ${secondsLeft}s`, "warning");
  }

  async runAccount() {
    const accountIndex = this.accountIndex;
    this.session_name = this.itemData.accountId;
    this.token = this.itemData.token;
    this.#set_headers();

    if (settings.USE_PROXY) {
      try {
        this.proxyIP = await this.checkProxyIP();
      } catch (error) {
        this.log(`Cannot check proxy IP: ${error.message}`, "warning");
        return;
      }
      const timesleep = getRandomNumber(settings.DELAY_START_BOT[0], settings.DELAY_START_BOT[1]);
      console.log(`=========Tài khoản ${accountIndex + 1} | ${this.proxyIP} | Bắt đầu sau ${timesleep} giây...`.green);
      await sleep(timesleep);
    }
    this.token = this.itemData.token;
    //   await this.getValidToken();
    // if (!token) return;
    // this.token = token;

    await this.connectRPC();
    let userData = await this.getUserInfo();
    let claimStatusData = await this.getClaimStatus(userData?.last_claim);

    const blNear = await this.getNearBalance();
    const blHot = await this.getHotBalance();
    if (claimStatusData.success) {
      const { hot_in_storage } = claimStatusData.data;
      this.log(`Account_ID: ${this.itemData.accountId} |  Near: ${blNear} | Hot offchain: ${hot_in_storage / 1_000_000} | Hot onchain: ${blHot}`, "custom");
      if (blNear.isLessThanOrEqualTo(0.001) || !settings.AUTO_CLAIM_ONCHAIN) {
        await this.handleClaimFree();
      } else if (settings.AUTO_CLAIM_ONCHAIN) {
        await this.handleClaim();
      }

      await sleep(1);
    } else {
      return this.log("Can't get use info...skipping", "error");
    }
  }
}

async function runWorker(workerData) {
  const { itemData, accountIndex, proxy, hasIDAPI } = workerData;
  const to = new ClientAPI(itemData, accountIndex, proxy, hasIDAPI);
  try {
    await Promise.race([to.runAccount(), new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 24 * 60 * 60 * 1000))]);
    parentPort.postMessage({
      accountIndex,
    });
  } catch (error) {
    parentPort.postMessage({ accountIndex, error: error.message });
  } finally {
    if (!isMainThread) {
      parentPort.postMessage("taskComplete");
    }
  }
}

async function main() {
  console.log("Tool được phát triển bởi nhóm tele Airdrop Hunter Siêu Tốc (https://t.me/airdrophuntersieutoc)".yellow);
  const listAccounts = loadData("data.txt");
  const proxies = loadData("proxy.txt");

  // const workbook = XLSX.readFile("./data.xlsx");
  // const sheetName = workbook.SheetNames[0];
  // const worksheet = workbook.Sheets[sheetName];
  // const listAccounts = XLSX.utils
  //   .sheet_to_json(worksheet, {
  //     header: ["ACCOUNT_ID", "PRIVATE_KEY", "QUERY_ID", "TOKEN"],
  //     range: 1,
  //   })
  //   .map((row) => {
  //     let userData = querystring.parse(row.QUERY_ID);
  //     userData = JSON.parse(userData.user || "{}");
  //     if (!userData || !userData.username) {
  //       return null;
  //     }
  //     return {
  //       ACCOUNT_ID: `${userData.username}-hot.tg`,
  //       PRIVATE_KEY: row.PRIVATE_KEY.trim(),
  //       QUERY_ID: row.QUERY_ID.trim(),
  //       TOKEN: row.TOKEN ? String(row.TOKEN).trim() : null,
  //     };
  //   })
  //   .filter((row) => row !== null && row.ACCOUNT_ID && row.PRIVATE_KEY && row.QUERY_ID);

  if (listAccounts.length == 0 || (listAccounts.length > proxies.length && settings.USE_PROXY)) {
    console.log("Số lượng proxy và data phải bằng nhau.".red);
    console.log(`Data: ${listAccounts.length}`);
    console.log(`Proxy: ${proxies.length}`);
    process.exit(1);
  }
  if (!settings.USE_PROXY) {
    console.log(`You are running bot without proxies!!!`.yellow);
  }
  let maxThreads = settings.USE_PROXY ? settings.MAX_THEADS : settings.MAX_THEADS_NO_PROXY;

  const { endpoint: hasIDAPI, message } = await checkBaseUrl();
  if (!hasIDAPI) return console.log(`Không thể tìm thấy ID API, thử lại sau!`.red);
  console.log(`${message}`.yellow);
  const dataInit = listAccounts
    .map((val, i) => {
      const [privateKey, token] = val.split("|");
      if (!privateKey || !token) return null;
      const payload = jwtDecode(token);
      const itemData = {
        privateKey: privateKey,
        accountId: payload.account_id,
        device_id: payload.device_id,
        // queryId: val.QUERY_ID.trim(),
        token: token,
      };
      new ClientAPI(itemData, i, proxies[i], hasIDAPI, {}).createUserAgent();
      return itemData;
    })
    .filter((t) => Boolean(t));

  await sleep(1);
  while (true) {
    let currentIndex = 0;
    const errors = [];

    while (currentIndex < dataInit.length) {
      const workerPromises = [];
      const batchSize = Math.min(maxThreads, dataInit.length - currentIndex);
      for (let i = 0; i < batchSize; i++) {
        const worker = new Worker(__filename, {
          workerData: {
            hasIDAPI,
            itemData: dataInit[currentIndex],
            accountIndex: currentIndex,
            proxy: proxies[currentIndex],
          },
        });

        workerPromises.push(
          new Promise((resolve) => {
            worker.on("message", (message) => {
              if (message === "taskComplete") {
                worker.terminate();
              }
              if (settings.ENABLE_DEBUG) {
                console.log(message);
              }
              resolve();
            });
            worker.on("error", (error) => {
              console.log(`Lỗi worker cho tài khoản ${currentIndex}: ${error.message}`);
              worker.terminate();
              resolve();
            });
            worker.on("exit", (code) => {
              if (code !== 0) {
                errors.push(`Worker cho tài khoản ${currentIndex} thoát với mã: ${code}`);
              }
              resolve();
            });
          })
        );

        currentIndex++;
      }

      await Promise.all(workerPromises);

      if (errors.length > 0) {
        errors.length = 0;
      }

      if (currentIndex < dataInit.length) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
    await sleep(3);
    console.log("Tool được phát triển bởi nhóm tele Airdrop Hunter Siêu Tốc (https://t.me/airdrophuntersieutoc)".yellow);
    console.log(`=============Hoàn thành tất cả tài khoản | Chờ ${settings.TIME_SLEEP} phút=============`.magenta);
    await sleep(settings.TIME_SLEEP * 60);
  }
}

if (isMainThread) {
  main().catch((error) => {
    console.log("Lỗi rồi:", error);
    process.exit(1);
  });
} else {
  runWorker(workerData);
}
