const path = require("path");

const winston = require("winston");
const { combine, timestamp, label, printf } = winston.format;

const { io } = require("./io.js");
const { balloon } = require("./compress.js");
const { reloadTime } = require("./time_manager.js");
const { makePulseController } = require("./pulse_controller.js");
const { makeFormatWriter } = require("./format_writer.js");
const { makeRequest } = require("./request.js");

const processCommandLineOption = (optionArray, cb, ...rest) => {
	let isCommandInserted = false;
	process.argv.forEach((val, index) => {
		if(optionArray.indexOf(val) != -1) {
			cb.apply(null, rest);
			isCommandInserted = true;
		}
	});
	return isCommandInserted;
};

const COMMAND_LINE_OPTIONS = {
	test: ["--test", "-t"],
	help: ["--help", "-h"]
};
const IS_USER_NEED_SOME_HELP = processCommandLineOption(COMMAND_LINE_OPTIONS.help, () => {
	console.log("help option inserted! call successfully!");
	// 'exit' uses code 0 for notify the success
	process.exit(0);
});
const IS_TEST = processCommandLineOption(COMMAND_LINE_OPTIONS.test, () => {
	console.log("test option inserted! call successfully!");
});

const TEST_ENV_DIR_NAME = "korbit_sphere";
const PWD_PATH = IS_TEST ? `${path.resolve(__dirname)}/../${TEST_ENV_DIR_NAME}/` : `${path.resolve(__dirname)}/../`;
const DATA_STORAGE_ROOT_PATH = `${PWD_PATH}data/`;
const LOG_STORAGE_ROOT_PATH = `${PWD_PATH}log/`;
const DEBUG_LOG_STORAGE_PATH = `${LOG_STORAGE_ROOT_PATH}debug/`;
const INFO_LOG_STORAGE_PATH = `${LOG_STORAGE_ROOT_PATH}info/`;
const ERROR_LOG_STORAGE_PATH = `${LOG_STORAGE_ROOT_PATH}error/`;

const SUPPORTED_COINS = ["btc_krw", "etc_krw", "eth_krw", "xrp_krw"];
// exit code 9 - Invalid Argument - Either an unknown option was specified, or an option requiring a value was provided without a value.
const TARGET_COIN = SUPPORTED_COINS.includes(process.argv[2]) ? process.argv[2] : process.exit(9);
const DATA_STORAGE_PATH = DATA_STORAGE_ROOT_PATH + TARGET_COIN;

/* start:: initialize winston logger */
const defaultFormat = printf((info) => {
	return `${info.timestamp} [${info.label}] ${info.level}: ${info.message}`;
});
const httpLogger = winston.createLogger({
	format: combine(
		label({label: TARGET_COIN}),
		timestamp(),
		defaultFormat
	),
	transports: [
		new (winston.transports.File)({
			level: "debug",
			filename: DEBUG_LOG_STORAGE_PATH + `http_${TARGET_COIN}.log`
		}),
		new (winston.transports.File)({
			level: "error",
			filename: ERROR_LOG_STORAGE_PATH + `http_${TARGET_COIN}.log`
		})
	]
});
const appLogger = winston.createLogger({
	format: combine(
		label({label: TARGET_COIN}),
		timestamp(),
		defaultFormat
	),
	transports: [
		new (winston.transports.File)({
			level: "debug",
			filename: DEBUG_LOG_STORAGE_PATH + `app_${TARGET_COIN}.log`
		}),
		new (winston.transports.File)({
			level: "error",
			filename: ERROR_LOG_STORAGE_PATH + `app_${TARGET_COIN}.log`
		})
	]
})
/* end:: initialize winston logger */

const compressToFileAsync = (filename = "noname_compressed") => {
	io(`${DATA_STORAGE_PATH}/${filename}`).readFile().then((data) => {
		balloon(data).deflate().then((result) => {
			result.toFile(`${DATA_STORAGE_PATH}/${filename}_compressed`);
		});
	});
};

const makeTimerUpdater = (updateTime, toDoListCallback) => {
	let intervalId = null;
	return () => {
		if(intervalId !== null) {
			clearInterval(intervalId);
		}
		intervalId = setInterval(() => {
			toDoListCallback();
			//stockRequest.send();
		}, updateTime());
	};
};

/* start:: initialize http request module */
const requestOption = {
	protocol: "https:",
	hostname: "api.korbit.co.kr",
	port: 443,
	/* need to support other kind of coins */
	path: `/v1/ticker/detailed?currency_pair=${TARGET_COIN}`,
	method: "GET"
};

const requestPulseController = makePulseController(SUPPORTED_COINS.length);
const stockWriter = makeFormatWriter(DATA_STORAGE_PATH);
const stockRequest = makeRequest(requestOption);
let currTime = null;
let prevTime = reloadTime();
let prevState = null;

const updateStockRequestInterval = makeTimerUpdater(() => {
	return requestPulseController.getInterval();
}, () => {
	stockRequest.send();
});

stockRequest.beforeAll((response) => {
	// TODO :: refactoring this.. performance inefficiency
	requestPulseController.update(response.statusCode);
	currTime = reloadTime();
});

stockRequest.afterAll((response) => {
	prevTime = currTime;
	prevState = response.statusCode;
});

// 200 - OK
stockRequest.bind(200, (response, stockData) => {
	if(currTime.isDayPass(prevTime)) {
		compressToFileAsync(prevTime.getDate());
	}
	stockWriter.setFormat((data) => {
		return `${currTime.getCurrent()} ${data}\n`;
	});
	stockWriter.writeWithFormatAsync(currTime.getDate(), stockData);
});

// 429 - TOO MANY REQUEST
stockRequest.bind(429, (response) => {
	// if we detect too many request, then control time interval once
	// 429 response can be found several times continuously
	// so protect calling update function several times.
	if(prevState !== 429) {
		httpLogger.debug(`status code is ${response.statusCode} with ${requestPulseController.getInterval()}ms`);
		updateStockRequestInterval();
	}
});

// 403 - BAD GATEWAY
stockRequest.bind(403, (response, chunck) => {
	if(prevState !== 403) {
		httpLogger.error(`occur 403 BAD GATEWAY - ${response}`);
	}
});
/* end:: initialize http request module */

// run stock crawler
updateStockRequestInterval();

// gracefully stop for PM2's stop or restart
process.on("SIGINT", () => {
	console.log("SIGINT:: PM2 restart or stop process");
	appLogger.debug("SIGINT:: PM2 restart or stop process");
	
	//stockRequest.getAgent().destory();
});

// https://github.com/nodejs/node-v0.x-archive/issues/6339
// process.on("SIGKILL", () => {
// 	console.log("SIGKILL:: PM2 restart or stop process");
// 	appLogger.debug("SIGKILL:: PM2 restart or stop process");
	
// 	stockRequest.getAgent().destory();
// });

process.on("uncaughtException", (err) => {
	console.error("process uncaughtException error occur!");
	appLogger.error(err.stack);
	
	//stockRequest.getAgent().destory();
});

process.on("exit", (code) => {
	console.log("exit code is " + code);
	
	// if agent is keepAlive, then sockets may hang open for quite a long time 
	// before the server terminates them.
	//stockRequest.getAgent().destory();
});
