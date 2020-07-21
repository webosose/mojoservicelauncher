// Copyright (c) 2009-2020 LG Electronics, Inc.
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
var bootstrap = require('./bootstrap');
var fs = global['fs'] ? global['fs'] : require('fs');

appController = undefined;

function loadAndStart(paramsToScript, appId) {
	var service_dir = paramsToScript[1];

	var palmbus = global['palmbus'] ? global['palmbus'] : require('palmbus');
	palmbus.setAppId(appId, service_dir);

	// Deprecated: we need to change context of current process. After pushing
	// service roles, the instance will appear from the hub as non-privileged
	// service with own specific role and permissions.
	//
	// After all services have been migrated to ACG, the whole statement can be
	// removed.
	if (process.getuid() === 0) {
		var dir = paramsToScript[0];
		try {
			var publicRolePath  = dir + '/roles/pub/' + appId + '.json';
			var privateRolePath = dir + '/roles/prv/' + appId + '.json';

			var publicHandle = null;
			var privateHandle = null;

			if (fs.existsSync(publicRolePath)) {
				publicHandle = new palmbus.Handle(null, true);
			}

			if (fs.existsSync(privateRolePath)) {
				privateHandle = new palmbus.Handle(null, false);
			}

			if (publicHandle) {
				publicHandle.pushRole(publicRolePath);
			}

			if (privateHandle) {
				privateHandle.pushRole(privateRolePath);
			}
		} catch (e) {
			console.error('pushRole failed with: ' + e);
			throw e;
		}
	}

	if (fs.existsSync('package.json')) { // webos-service based Node module
		//console.log('loading node module from ' + service_dir);
		var mod = require(service_dir);
		if (mod.run) {
			mod.run(appId);
		}
	} else {
		console.error("Couldn't determine launch file for service path " + service_dir);
		throw new Error("Couldn't determine launch file for service path " + service_dir);
	}
}

bootstrap.parse(loadAndStart);
