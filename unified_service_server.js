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

var local_socket_file = "/var/run/unified_service_server";
var local_socket_mode = 0600;

var bootstrap = require('bootstrap');
var webossrv = require('webos-service');
var domain    = global['domain-utils'] ? global['domain-utils'] : require('domain-utils');
var fs        = global['fs']           ? global['fs']           : require('fs');
var net       = global['net']     ? global['net']     : require('net');
var palmbus   = global['palmbus'] ? global['palmbus'] : require('palmbus');
var path      = global['path'] ? global['path'] : require('path');
var util      = global['util'] ? global['util'] : require('util');

bootstrap.setConsole('unified_service_server');
process.title = 'unified_service_server';

skip_trace = false;
var gcctrl;

unified_service = { activityCount: 0 };

unified_service.increaseActivity = function() {
	this.activityCount++;
};

unified_service.decreaseActivity = function() {
	this.activityCount--;
};

unified_service.getActivityCount = function() {
	return this.activityCount;
};

unified_service.enterIdle = function() {
	if (gcctrl)
		gcctrl.gc();
};

unified_service.unrequire = function(filename) {
	var mod = require.cache[filename];
	if (mod) {
		var parentChildren = mod.parent.children;
		for (var i = 0; i < parentChildren.length; ++i) {
			if (mod === parentChildren[i]) {
				parentChildren.splice(i, 1);
				break;
			}
		}

		deleteModule(mod);

		if (gcctrl) {
			gcctrl.gc();
		}
	}
};

unified_service.require = function(path) {
	var filename = require.resolve(path);
	this.serviceMain = filename;
	return require(filename);
};

function deleteModule(mod) {
	mod.children.forEach(function(child) {
		deleteModule(child);
	});

	delete require.cache[mod.id];
}

(function() {
	var argv = process.argv;
	for (var i = 2; i < argv.length; ++i) {
		if (0 == argv[i].indexOf('--gc_pending_time=')) {
			var match = argv[i].substring(18).match(/^(\d+)$/);
			if (match) {
				gcctrl = gcctrl || require('./gcctrl');
				gcctrl.set(parseInt(match[1]));
			} else {
				throw 'Invalid parameter: ' + argv[i];
			}
		} else {
			throw 'Invalid option: ' + argv[i];
		}
	}
})();

try {
	IMPORTS.mojoservice = global['mojolibname'] ? global['mojolibname'] : MojoLoader.require({name: 'mojoservice', version: '1.0'}).mojoservice;
	var webos = global['webos'] ? global['webos'] : require('webos');
	appController = undefined;
} catch (e) {
	console.log('mojoservice does not exist');
}

function loadSource(service_dir) {
	try {
		var files = JSON.parse(bootstrap.loadFile(path.join(service_dir, 'sources.json'), 'utf8'));
		var len = files.length;
		var i = 0;
		for (; i < len; i++) {
			if (!files[i].override) {
				break;
			}
			MojoLoader.override(files[i].override);
		}

		var svc = JSON.parse(fs.readFileSync(path.join(service_dir, "services.json"), "utf8"));
		var svc_name = svc.services[0].name.replace(/\./g, "__"); //replace . with __ (com__palm__service__hello)
		//console.log("svc_name: " + svc_name);
		var src_prefix = "global['"+svc_name+"'] = (function() {\n\n";
		var src = src_prefix;

		for (; i < len; i++) {
			var file = files[i];
			if (file.source) {
				src += fs.readFileSync(path.join(service_dir, file.source), 'utf8');
				src += "\n/*******************************************************/\n\n";
			}

			if (file.library) {
				var libname = MojoLoader.builtinLibName(file.library.name, file.library.version);
				if (!global[libname]) {
					IMPORTS[file.library.name] = MojoLoader.require(file.library)[file.library.name];
				} else {
					IMPORTS[file.library.name] = global[libname];
				}
			}
		}

		var src_suffix = "function ns() {};\n";
		var svc_commands = svc.services[0].commands;
		for (var i = 0; i <svc_commands.length; i++) {
			var cmd_asst = svc_commands[i].assistant;
			src_suffix += "if (typeof("+cmd_asst+") == 'function')\n  ns.prototype."+cmd_asst+" = "+cmd_asst+";\n\n";
		}
		var svc_asst = svc.services[0].assistant;
		if (svc_asst) {
			src_suffix += "if (typeof("+svc_asst+") == 'function')\n  ns.prototype."+svc_asst+" = "+svc_asst+";\n\n";
		}
		src_suffix += "return ns;\n\n";
		src_suffix += "})();\n";
		src += src_suffix;
		if (!fs.existsSync(path.join("/var", ".tmp")))
			fs.mkdirSync(path.join("/var", ".tmp"));
		var file_name = path.join("/var", ".tmp", svc_name + ".js");
		fs.writeFileSync(file_name, src);
		webos.include(file_name);

		// cleanup
		file_name = null;
		src = null;
		src_suffix = null;
		src_prefix = null;
		file = null
		svc_asst = null;
		cmd_asst = null;
		svc_commands = null;
		svc = null;
		svc_name =  null;
		files = null;
	} catch (e) {
		if (file) {
			console.error('Loading failed in: ', file.source || file.library.name);
		}
		console.error(e.stack || e);
	}
}

function loadAndStart(paramsToScript, appId) {
	var service_dir = paramsToScript[1];

	process.domain.service_dir = service_dir;

	if (fs.existsSync('package.json')) { // webos-service based Node module
		palmbus.setAppId(appId, service_dir);
		//console.log('loading node module from ' + service_dir);
		process.argv = paramsToScript;
		var mod = unified_service.require(service_dir);
		if (mod.run) {
			mod.run(appId);
		}
		if (!domain.findFirstCallback(process.domain))
			unified_service.unrequire(service_dir);
	} else if (fs.existsSync('sources.json')) { // mojoservice-based service
		loadSource(service_dir);
		appController = new IMPORTS.mojoservice.AppController(paramsToScript);
	} else {
		console.error("Couldn't determine launch file for service path " + service_dir);
	}
}

function generateRestartSignal() {
	var exec = require('child_process').exec, child;
	var cmd = '[ -f /tmp/unified_service_server_restart ] && initctl emit --no-wait unified_service_server_restart';
	child = exec(cmd, function(err, stdout, stderr) {
		console.log('STDOUT:' + stdout);
		console.log('STDERR:' + stderr);
		if (err !== null) {
			console.error('exec error: ' + err);
		}
	});
}

/*
 * Define setter and getter to separate process.argv for each running service
 */
process.__defineGetter__('argv', function() {
	if (!process.domain) return process._argv || [];
	return process.domain.argv || [];
});

process.__defineSetter__('argv', function(args) {
	if (!process.domain) process._argv = args;
	else process.domain.argv = args;
});

/*
 * Initialize and start user service application module.
 */
function init(input_params) {
	var input_args = input_params.toString().match(/\S+/g);
	//console.log('input_args: ' + input_args);
	var params = ['',''].concat(input_args);
	//console.log('client disconnected');
	var d = domain.create();
	d.on('error', function(err) {
		console.error("EXCEPTION IN USER SERVICE APPLICATION:");
		console.error("Error Object:");
		util.inspect(err,{showHidden: true, depth: 1}).split(/\r?\n/)
		    .forEach(function(s) {console.error(s)});
		console.error("Stack trace:");
		err.stack.toString().split(/\r?\n/)
		   .forEach(function(s) {console.error(s)});
		// Unload user service application module if possible.
		if (err.domain && err.domain.service_dir) {
			var mainModuleFile = require.resolve(err.domain.service_dir);
			unified_service.unrequire(mainModuleFile);
		}
	});
	d.run(function() {
		bootstrap.parse(loadAndStart, params);
	});
}

/*
 * Start server.
 */
var server = net.createServer(function(socket) {
	console.log('server net.createServer');
	var inputData = '';
	socket.on('data', function(data) {
		//console.log('data received from client: ' + data);
		inputData += data.toString();
	});
	socket.on('end', function() {
		console.log("client disconnected");
		if (inputData) init(inputData);
	});
});
server.on('error', function(err) {
	console.log('server.on error');
	if (err.code && err.code === "EADDRINUSE") {
		// try to connect to check if it in use
		var socket = new net.Socket;
		socket.on('error', function(err) { // socket not in use, removing the file
			fs.unlink(local_socket_file, function(err){
				if (err) {
					console.log("Can't unlink broken local socket file " + local_socket_file);
					throw err;
				}
				console.log('Broken local socket file "%s" removed.', local_socket_file);
				server.listen(local_socket_file);
			});
		});
		socket.connect(local_socket_file, function() { // socket is in use, exit
			console.log("Server already runned.");
			socket.destroy();
		});
	} else {
		console.log(util.inspect(err,{showHidden: true, depth: 1}));
	}
});
server.on('listening', function() {
	fs.chmodSync(local_socket_file, local_socket_mode);

	// process.on('exit' not triggered without this handlers
	process.on('SIGINT',  function() {process.exit()});
	process.on('SIGTERM', function() {process.exit()});
	process.on('exit',    function() {
		console.log('Server closed on %j', server.address());
		fs.unlinkSync(local_socket_file);
	});
	process.on('uncaughtException', function(err) {
		console.error("UNCAUGHT EXCEPTION:");
		if (typeof err.stack === 'undefined') {
			console.error(err);
		}
		else {
			err.stack.toString().split(/\r?\n/)
				.forEach(function(s) {console.error(s)});
		}
		process.exit(1); // returning non zero will be restarted this by upstart
	});
	console.log('Server running on %j', server.address());
	generateRestartSignal();
});
server.listen(local_socket_file);
