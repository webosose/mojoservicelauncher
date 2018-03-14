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

var cwd = process.cwd();

global.sandbox = {};

// TODO (isherstobitov): should be changed to read from config file
global.sandbox.serverOptions = {};

// set unix socket as default server address
// global.sandbox.serverOptions.path = "/var/run/node_fork_server.socket";
// default value for tcp port
global.sandbox.serverOptions.port = 9000;

// restrict access to node_fork_server only for root
// in case of using unix socket
global.sandbox.serverOptions.umask = 077;

if (process.env.NODE_FORK_SERVER_HOST) {
	var host = process.env.NODE_FORK_SERVER_HOST;
	if (host[0] == '/') {
		global.sandbox.serverOptions.path = host;
		if (global.sandbox.serverOptions.port)
			delete global.sandbox.serverOptions.port;
	} else {
		global.sandbox.serverOptions.host = host;
	}
}

var umaskOnStart = global.sandbox.serverOptions.umask ?
    process.umask(global.sandbox.serverOptions.umask) : process.umask();

global.sandbox.prettyArgs = process.env.NODE_PRETTY_ARGS;
process.env.NODE_PRETTY_ARGS = null;
process.title = "node_fork_server";

global.sandbox.preforkMem = process.memoryUsage();

global.sandbox.log = function (msg) {
	if (global['pmloglib']) {
		global['pmloglib'].log(process.pid + ": [node_fork_server] ["+
			((new Date()).getTime()) + ", " + process.uptime() + "] " + msg);
	} else {
		console.log(process.pid + ": [node_fork_server] [" +
			((new Date()).getTime()) + ", " + process.uptime() + "] " + msg);
	}
};

var preload = ["webos", "pmloglib", "mojoloader", "palmbus", "webos-service",
				"bootstrap", "http", "https"];
for (var i = 0, ni = preload.length; i < ni; i++) {
	try {
		var module = preload[i];
		global[module] = require(module);
	} catch (e) {
		global.sandbox.log("Failed to pre-load " + preload[i] + ": " + e +
							"\n Exception stack: " + e.stack);
	}
}

global.sandbox.log(__filename + ": NODE_PATH=" + process.env.NODE_PATH);
global.sandbox.log(__filename + ": NODE_PRETTY_ARGS=" + global.sandbox.prettyArgs);

var fs = require('fs');
var child_process = require('child_process');
var net = require('net');
var Buffer = require('buffer').Buffer;
var path = require('path');
var Module = require('module');
var respawn_count = {}; // {serviceDir: count}
var MAX_RESPAWN = 10; //Child process will be respawned 10 times before give up.
global.sandbox.parseMessage = function(stream, chunk, msgHandler) {

	var message = null;
	var right_curly = "}".charCodeAt(0);
	var new_line = "\n".charCodeAt(0);

	if (chunk !== '') {
		if (typeof chunk == "string")
			chunk = new Buffer(chunk);
		if (stream.buffered) {
			var expanded = Buffer.concat([stream.buffered, chunk], stream.buffered.length + chunk.length);
			stream.buffered = expanded;
		} else {
			stream.buffered = chunk;
		}

		var ni = stream.buffered.length;

		// assume that '}' in the end of the file/line can be final '}' in json
		if ((stream.buffered[ni-1] == right_curly) ||
		    (stream.buffered[ni-2] == right_curly && stream.buffered[ni-1] == new_line)) {
			message = stream.buffered;
		}
	} else {
		message = stream.buffered;
	}

	if (message) {
		global.sandbox.log("Found message '" + message + "'");
		try {
			msgHandler(stream, message);
		} catch (e) {
			global.sandbox.log("Exception in message handler for '" + message + "': " +
			    e + "\n Exception stack: " + e.stack);
		}
	} else {
		global.sandbox.log("No message found in '" + stream.buffered + "'");
	}
};

global.sandbox.sendMessage = function(stream, obj) {
	var objStr = JSON.stringify(obj);
	var msg = new Buffer(Buffer.byteLength(objStr, 'utf8') + 1);
	msg.write(objStr);
	msg[msg.length - 1] = 0;
	return stream.write(msg);
};

String.prototype.startsWith = function(prefix) {
	if (this.length < prefix.length) {
		return false;
	}
	if (this.length == prefix.length) {
		return this === prefix;
	}
	for (var i = 0, ni = prefix.length; i < ni; i++) {
		if (this[i] != prefix[i]) {
			return false;
		}
	}
	return true;
};


global.sandbox.forkHandler = function(request, spawnRequestStream) {
	//global.sandbox.log("forkHandler--> request: " + JSON.stringify(request));
	// need a more persistent sandbox for some of the
	// convenience functions
	var __spawnSandbox = {
		log : global.sandbox.log,
		sendMessage : global.sandbox.sendMessage
	};

	__spawnSandbox.log("Fork setup code...");

	global.sandbox.spawnServer.removeAllListeners();

	//__spawnSandbox.log("global.sandbox.prettyArgs=" + global.sandbox.prettyArgs);
	process.env.NODE_PRETTY_ARGS = global.sandbox.prettyArgs;
	//__spawnSandbox.log("process.argv[0]="+process.argv[0]);
	request.args.unshift(process.argv[0], request.script);
	//__spawnSandbox.log("request.args="+request.args);

	//console.log("delete global.sandbox returns: " + delete global.sandbox);

	__spawnSandbox.log(process.pid + " successfully forked");

	// enter jail if needed

	if (request.chroot) {
		process.chroot(request.chroot);
		__spawnSandbox.log(process.pid + " successfully chrooted");
	}
	if (request.appid)
		process.env.APPID=request.appid;
	if (request.home)
		process.env.HOME=request.home;

	if (request.j_uid) {
		var group_id = request.j_gid || request.j_uid;
		process.initgroups(request.j_uid, group_id);
		process.setgid(group_id);
		process.setuid(request.j_uid);
	} else if (request.j_gid) {
		process.setgid(request.j_gid);
	}
	{
		var isURL;
		process.argv = process.ARGV = request.args;

		// logic from node.js.  argv[0] doesn't need to be adjusted
		// since it's already adjusted when the fork daemon starts up
		if (process.argv[1].charAt(0) != "/" && !(isURL = process.argv[1].startsWith("http://"))) {
			process.argv[1] = path.join(cwd, process.argv[1]);
		}

		__spawnSandbox.originalScript = request.script;

		// NOTE: this will block the script from exiting even if it can
		// the fork server has to close stdin (which happens automatically
		// when the remote side goes away).
		var stdin = process.openStdin();
		stdin.on('error', function(e) {
			// EAGAIN is a weird error, but we don't care about it
			__spawnSandbox.log("forkHandler stdin.on('error'): "+e);
		});
	}
	__spawnSandbox.log("Running user script");
	// clear references to variables that aren't necessary in the child
	var cpid = process.pid;
	request = undefined;
	try {
		Module.runMain();
		if (parseInt(process.env.NODE_PRETTY_ARGS)) {
			process.argv.splice(0, 1);
			process.argv[0] = __spawnSandbox.originalScript;
			process.title = process.basename(__spawnSandbox.originalScript);
		}

		__spawnSandbox.log("Sending notification that child is ready");
		__spawnSandbox.sendMessage(spawnRequestStream, {spawned : true, pid : cpid});
		spawnRequestStream.end();
		spawnRequestStream.removeAllListeners();
		spawnRequestStream.destroy();
		spawnRequestStream = null;
	} catch (e) {
		__spawnSandbox.log("Something wrong with child script: " + e.stack ? e.stack : e.message);
		__spawnSandbox.sendMessage(spawnRequestStream, {spawned : false, errorText : e.message});
		process.exit(1);
	}
};

global.sandbox.streamMsgHandler = function(_stream, data) {
	var request;
	try {
		request = JSON.parse(data.toString());
	} catch(e) {
		global.sandbox.log("Problem parsing '" + data + "' (" + data.length + ") : " + e +
			"\n Exception stack: " + e.stack);
		return;
	}
	if (request.spawn) {
		if (!request.args) {
			request.args = [];
		} else {
			// first arg is directory that the child should be running in
			var dir = request.args.shift();
			if (dir) {
				request.serviceDir = dir;
				global.sandbox.log("Changing to directory: " + dir);
				process.chdir(dir);
			} else {
				global.sandbox.log("Unable to get directory from args");
			}
		}

		var forkedChild;

		if (global.sandbox.compacted === undefined) {
			global.sandbox.compacted = true;
			if (process.gc) {
				process.gc();
				process.gc();
				process.gc();
			} else {
				global.sandbox.log("GC not exposed");
			}
		}

		try {
			request.noexec = true;
			global.sandbox.log("forking..");
			// TODO: do we need to pass forkHandler to fork()?
			forkedChild = child_process.fork(global.sandbox.forkHandler, request);
		} catch (e) {
			global.sandbox.log("Trouble spawning script: " + e + "\n Exception stack: " + e.stack);
			global.sandbox.sendMessage(_stream, {spawned: false, errMsg : JSON.stringify(e)});
			_stream.end();
			return;
		}

		if (forkedChild.pid == 0) {

			var SIGINT_EXITCODE = 128+2;
			var SIGTERM_EXITCODE = 128+15;

			global.sandbox.log("In the child process: handling fork..");

			process.removeAllListeners('SIGINT');
			process.removeAllListeners('SIGTERM');

			process.on('SIGINT', function() {
				setTimeout(function() {
					process.exit(SIGINT_EXITCODE);
				});
			});
			process.on('SIGTERM', function() {
				setTimeout(function() {
				process.exit(SIGTERM_EXITCODE);
				});
			});

			process.stdio = process.stdout = process.stderr = null;

			// for IPC
			if (process.env.NODE_CHANNEL_FD) {
				var fd = parseInt(process.env.NODE_CHANNEL_FD);
				delete process.env.NODE_CHANNEL_FD;
				child_process._forkChild(fd);
			}

			global.sandbox.forkHandler(request, _stream);
			global.sandbox.log("Exiting child process..");
			return;
		} else {
			//global.sandbox.log("In the parent process: destroying node_spawner stream..");
			_stream.removeAllListeners();
			_stream.destroy();
			_stream = null;
		}

		global.sandbox.log("(" + forkedChild.pid + ") Forked script " +
			request.script + ", childstdout: " + request.childstdout +
			", childstderr: " + request.childstderr);

		var forkedPid = forkedChild.pid;
		forkedChild.on('exit', function(code, signum) {
			global.sandbox.log("(" + forkedPid + ") " + "Exited with "
				+ (code == null ? "no exit code" : code) + (signum == null ? "" : ", signal " + signum));
			if(request.args.indexOf("--respawn") > -1) {
				if(respawn_count[request.serviceDir]) {
					respawn_count[request.serviceDir]++;
				}
				else {
					respawn_count[request.serviceDir] = 1;
				}
				if(respawn_count[request.serviceDir] <= MAX_RESPAWN) {
					global.sandbox.log("Re-spawning the child process after 2 secs");
					setTimeout(global.sandbox.respawnChild, 2000, request);
				}
			}
		});

		//global.sandbox.log("streamMsgHandler: forkedChild.stdout=" + forkedChild.stdout);
		//global.sandbox.log("streamMsgHandler: forkedChild.stderr=" + forkedChild.stderr);
		//global.sandbox.log("streamMsgHandler: forkedChild.stdin=" + forkedChild.stdin);

		if (forkedChild.stdout) {
			forkedChild.stdout.on('data', function (data) {
				global.sandbox.log("stdout from spawned child: " + data);
			});
			forkedChild.stdout.on('error', function (e) {
				global.sandbox.log("Error on stdout pipe from spawned child: " + e);
			});
		}

		if (forkedChild.stderr) {
			forkedChild.stderr.on('data', function (data) {
				global.sandbox.log("stderr from spawned child: " + data);
			});
			forkedChild.stderr.on('error', function (e) {
				global.sandbox.log("Error on stderr pipe from spawned child: " + e);
			});
		}

		global.sandbox.log("streamMsgHandler<--");
		return;
	}

	global.sandbox.log("Unhandled request '" + data + "' from " + _stream ? _stream.remoteAddress : undefined);
};

global.sandbox.respawnChild = function(request) {
	global.sandbox.log("Respawning child..." + JSON.stringify(request));
	var ind = request.args.indexOf(request.serviceDir);
	if(ind > -1) {
		request.args.unshift(request.serviceDir);
	}

	var client = net.connect({path: global.sandbox.serverOptions.path }, function() {
		client.write(JSON.stringify(request));
	});

	client.on('data', function(data) {
		client.end();
	});

};

global.sandbox.spawnServerListening = function() {
	var upstart_job = process.env['UPSTART_JOB'];
	var emit_ready = false;
	var stat = undefined;

	// restore umask
	process.umask(umaskOnStart);

	// Only emit the upstart "ready" event once per boot to avoid
	// re-triggering dependent jobs in the event of a crash or restart
	try {
		stat = fs.statSync('/tmp/node_fork_server.upstart');
		global.sandbox.log('Upstart file exists');
	} catch (e) {}

	if (!stat) {
		global.sandbox.log('Upstart file does not exist; creating');
		try {
			fs.writeFileSync('/tmp/node_fork_server.upstart', '');
		} catch (e) {
			global.sandbox.log('Warning: unable to create upstart flag: ' + e.message
				+ "\n Exception stack: " + e.stack);
		}
		emit_ready = true;
	}

	if (emit_ready && upstart_job) {
		global.sandbox.log('Emitting upstart event');
		child_process.exec("/sbin/initctl emit --no-wait " + upstart_job + "-ready",
			function (error, stdout, stderr) {
				global.sandbox.log("upstart emit stdout: " + stdout);
				global.sandbox.log("upstart emit stderr: " + stderr);
				if (error !== null) {
					global.sandbox.log('upstart emit exec error: ' + error);
				}
			}
		);
	}
	global.sandbox.log("Ready");
};

global.sandbox.spawnServer = net.createServer(function(stream) {

	stream.setNoDelay();
	stream.on('connect', function() {
		//global.sandbox.log("Connection from " + this.remoteAddress);
	});
	stream.on('end', function() {
		global.sandbox.parseMessage(this, '', global.sandbox.streamMsgHandler);
		this.end();
		this.destroy();
	});
	stream.on('error', function(e) {
		this.end();
		this.destroy();
	});
	stream.on('data', function(data_) {
		global.sandbox.parseMessage(this, data_, global.sandbox.streamMsgHandler);
	});
});

global.sandbox.spawnServer.on('error', function (e) {

	var self = this;

	if (e.code == 'EADDRINUSE') {
		// inspired by unified_service_server
		// _pipeName is internal copy of unix socket file name
		var socket = new net.Socket;
		socket.on('error', function(err) { // socket not in use, removing the file
			if (self._pipeName) {
				fs.unlink(self._pipeName, function(err) {
					if (err) {
						global.sandbox.log("Can't unlink broken local socket file %s: %s", self._pipeName, err.code);
						process.exit();
					}
					global.sandbox.log('Broken local socket file "%s" removed.', self._pipeName);
					self.listen(self._pipeName);
				});
			}
		});
		socket.connect(self._pipeName, function() { // socket is in use, exit
			global.sandbox.log("Server is already running.");
			socket.end();
			self.close();
			process.exit();
		});
	} else {
		throw e;
	}
});

// gracefully shutdown
function shutdownServer() {
	global.sandbox.spawnServer.close();
	process.exit();
};

process
	.on('SIGINT', shutdownServer)
	.on('SIGTERM', shutdownServer);

global.sandbox.spawnServer.listen(global.sandbox.serverOptions, global.sandbox.spawnServerListening);
