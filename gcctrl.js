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

var fs = require('fs');

var conf = {
	repeatCount: 1,  // times
	cpuThreshold: 1, // percent
	pendingTime: 30  // seconds
};

var data = {
	pendingTimer: null,
	idleTimer: null,
	retryTimer: null,

	hasPending: false,
	repeatCount: 0,

	gcFunc: global.gc
};

function set(pendingTime) {
	conf.pendingTime = pendingTime;

	console.log('gcctrl configuration: gc_pending_time ' + conf.pendingTime);
}

function gc() {
	data.repeatCount = 0;
	process.nextTick(requestGc);
}

function requestGc() {
	if (data.pendingTimer) {
		data.hasPending = true;
	} else if (0 === unified_service.getActivityCount()) {
		runGc();
	} else if (!data.idleTimer) {
		runGcIfIdle();
	}
}

function runGc() {
	if (data.idleTimer) {
		clearTimeout(data.idleTimer);
		data.idleTimer = null;
	}
	if (data.retryTimer) {
		clearTimeout(data.retryTimer);
		data.retryTimer = null;
	}

	data.gcFunc();
	console.log('runGc');

	if (conf.pendingTime) {
		if (0 === data.repeatCount)
			data.pendingTimer = setTimeout(pendingTimeout, conf.pendingTime * 1000);
		else
			process.nextTick(pendingTimeout);
	}
}

function pendingTimeout() {
	data.pendingTimer = null;

	if (data.hasPending) {
		data.hasPending = false;
		requestGc();
	} else if (data.repeatCount < conf.repeatCount) {
		data.repeatCount++
		requestGc();
	}
}

function runGcIfIdle() {
	if (data.retryTimer) {
		clearTimeout(data.retryTimer);
		data.retryTimer = null;
	}

	data.idleTimer = cpuUsage(function(percent) {
		data.idleTimer = null;

		if (conf.cpuThreshold >= percent) {
			runGc();
		} else {
			retryLater();
		}
	});
}

function cpuUsage(callback) {
	var ticks1;

	cpuTicks(function(ticks) {
		ticks1 = ticks;
	});

	return setTimeout(function() {
		cpuTicks(function(ticks2) {
			// cpu usage = (ticks2 - ticks1) * 100 / herz / duration
			callback(ticks2 - ticks1);
		});
	}, 1000);
}

function cpuTicks(callback) {
	fs.readFile('/proc/self/stat', 'ascii', function(err, data) {
		var stat = data.split(' ', 15);
		callback(parseInt(stat[13]) + parseInt(stat[14])); // utime + stime
	});
}

function retryLater() {
	var random = Math.floor(Math.random() * conf.pendingTime);
	data.retryTimer = setTimeout(retryTimeout, random * 1000);
}

function retryTimeout() {
	data.retryTimer = null;
	requestGc();
}

if (!data.gcFunc)
	throw 'global.gc is not exposed';

exports.set = set;
exports.gc = gc;
