// Copyright (c) 2015-2018 LG Electronics, Inc.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
// SPDX-License-Identifier: Apache-2.0
MojoLoader = global['mojoloader'] ? global['mojoloader'] : require('mojoloader');
var fs = global['fs'] ? global['fs'] : require('fs');

IMPORTS = {require: require};

// Patch to convert legacy http calls to new ones
var version = process.version.split('.');
var majorVersion = version[0].substring(1);
var minorVersion = version[1];
if ((majorVersion == 0 && minorVersion >= 4) || majorVersion > 0) {
	(function() {
		var http = require('http');
		var https = require('https');
		var EventEmitter = require('events').EventEmitter;
		http.createClient = function(port, host, secure) {
			var module = secure ? https : http;
			var client = new EventEmitter();
			var options = {
				port: port,
				host: host
			};
			client.request = function(method, path, headers) {
				options.method = method;
				options.path = path;
				options.headers = headers;
				var request = module.request(options, function(response) {});
				return request;
			};
			return client;
		};
	}());
}
version = majorVersion = minorVersion = undefined;

function loadFile(path) {
	return fs.readFileSync(path, 'utf8');
}

function writeGroupFile(groupfile) {
	return fs.writeFileSync(groupfile, process.pid.toFixed(0) + '\n', 'utf8');
}

function parseParams(params) {
	var paramsToScript;
	var appId;

	var paramsIndex = params.indexOf('--', 2) + 1;
	if (0 < paramsIndex && paramsIndex < params.length) {
		paramsToScript = params.slice(paramsIndex);
		try {
			var cgroup = paramsToScript.splice(0, 1);
			writeGroupFile(cgroup[0]);
		} catch (e) {
			console.error('Unable to get cgroup: ' + e);
		}
	} else {
		paramsToScript = [];
	}

	try {
		if (global.unified_service) {
			console.log('SERVICE DIRECTORY: ' + paramsToScript[1]);
			process.chdir(paramsToScript[1]);
		}

		var config;
		if (fs.existsSync('services.json')) {
			config = JSON.parse(loadFile('services.json'));
			appId = config.id || config['services'][0].name;
		} else {
			config = JSON.parse(loadFile('package.json'));
			appId = config.name;
		}
	} catch (e) {
		console.error('parsing services.json failed with: ' + e);
	}

	if (process.setArgs) {
		// Palm-modified Node.js 0.4
		var shortname = appId.slice(appId.length - 12) + '.js';
		var args = paramsToScript.slice(0);
		args[0] = appId + '.js';

		process.setArgs(args);
		process.setName({shortname: shortname});
	} else {
		// Node.js 0.10
		if (!global.unified_service) {
			process.title = appId;
		}
	}

	return { appId: appId, params: paramsToScript };
}

function getConsoleName(fullName) {
	var max_len = 63;
	var cname = fullName;
	var len = cname.length;
	if (len > max_len) {
		var i = 0;
		while (i < len && i != -1 && (len - i) > max_len) {
			i = cname.indexOf('.', i + 1);
		}
		if (i > -1) {
			cname = cname.substring(i + 1);
		} else {
			cname = cname.substring(fullName.length - max_len);
		}
	}
	return cname;
}

exports.parse = function(loadAndStart, params) {
	var conf = parseParams(params || process.argv);

	loadAndStart(conf.params, conf.appId);
}

exports.loadFile = loadFile;
