// Copyright (c) 2009-2018 LG Electronics, Inc.
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

function loadSource() {
	try {
		var files = JSON.parse(bootstrap.loadFile('sources.json', 'utf8'));
		var len = files.length;
		var i = 0;
		for (; i < len; i++) {
			if (!files[i].override) {
				break;
			}
			MojoLoader.override(files[i].override);
		}

		var webos = global['webos'] ? global['webos'] : require('webos');
		IMPORTS.mojoservice = global['mojolibname'] ? global['mojolibname'] : MojoLoader.require({name: 'mojoservice', version: '1.0'}).mojoservice;

		for (; i < len; i++) {
			var file = files[i];
			file.source && webos.include(file.source);

			if (file.library) {
				var libname = MojoLoader.builtinLibName(file.library.name, file.library.version);
				if (!global[libname]) {
					IMPORTS[file.library.name] = MojoLoader.require(file.library)[file.library.name];
				} else {
					IMPORTS[file.library.name] = global[libname];
				}
			}
		}
	} catch (e) {
		if (file) {
			console.error('Loading failed in: ', file.source || file.library.name);
		}
		console.error(e.stack || e);
		throw e;
	}
}

function loadAndStart(paramsToScript, appId) {
	bootstrap.setConsole(appId);

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
	} else if (fs.existsSync('sources.json')) { // mojoservice-based service
		loadSource();
		appController = new IMPORTS.mojoservice.AppController(paramsToScript);
	} else {
		console.error("Couldn't determine launch file for service path " + service_dir);
		throw new Error("Couldn't determine launch file for service path " + service_dir);
	}
}

bootstrap.parse(loadAndStart);
