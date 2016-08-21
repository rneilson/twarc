'use strict';

const EventEmitter = require('events');

const defaults = {
	heartbeat: true,
	hearttime: 2000,
	waitforgo: false
};

class Managed extends EventEmitter {

	constructor (options, log, err) {
		super();
		this.options = Object.assign({}, defaults, options);
		// Logger
		this.log = log || console.log.bind(console);
		this.err = err || console.error.bind(console);
		// Message handling
		process.on('message', this.recvmsg.bind(this));
		// Heartbeat management
		process.on('exit', () => {
			if (this.heartbeatInterval) {
				clearInterval(this.heartbeatInterval);
			}
		});
		if (this.options.heartbeat && !this.options.waitforgo) {
			this.go();
		}
	}

	// Handler for message recipt
	recvmsg (msg, handle) {
		// Emit heartbeat
		if (msg === 'heartbeat') {
			// TODO: add heartbeat tracking per-child
			this.emit('heartbeat', new Date(), handle);
		}
		// Emit message as event if string
		// (Equivalent to {type: msg} with no payload)
		else if (typeof msg === 'string') {
			this.emit(msg, undefined, handle);
		}
		// Emit typed message if available
		else if (msg !== null && typeof msg === 'object' && msg.type) {
			this.emit(msg.type, msg.data, handle);
		}
		// Emit generic message event otherwise
		else {
			this.emit('message', msg, handle);
		}
	}

	// Send message to parent (manager)
	sendmsg (msg, handle, options) {
		// Promisify and return
		return new Promise((resolve, reject) => {
			// Sanity check
			if (!process.connected) {
				return reject(new Error('Not connected to parent process'));
			}
			// Deal with optional args
			let args = [];
			if (handle !== undefined) {
				args.push(handle);
				if (options !== undefined) {
					args.push(options)
				}
			}
			// Add callback to args
			process.send(msg, ...args, err => {
				if (err === null) {
					resolve();
				}
				else {
					reject(err);
				}
			});
		});
	}

	// Returns promise to be resolved once specified event received
	// NOTE: will resolve with array of args, since promises require single value
	waitfor (event, timeout) {
		return new Promise(function (resolve, reject) {
			let timeoutObj;

			if (timeout > 0) {
				timeoutObj = setTimeout(() => {
					reject(new Error(`Timed out waiting for event: ${event}`))
				});
			}

			this.once(event, (...args) => {
				if (timeoutObj) {
					clearTimeout(timeoutObj);
				}
				resolve(args);
			});
		});
	}

	go (message) {
		let promise;

		// Send given message first
		if (message !== undefined) {
			promise = this.sendmsg(message);
		}
		else {
			promise = this.sendmsg('heartbeat');
		}

		// Start heartbeat if cfg'd
		if (this.heartbeat) {
			let hbfn = this.sendmsg.bind(this, 'heartbeat');

			if (message !== undefined) {
				promise = promise.then(hbfn)
			}

			promise = promise.then(() => {
				this.heartbeatInterval = setInterval(hbfn, this.hearttime);
			});
		}

		// TODO: catch by default?
		// return promise.catch(e => Promise.reject(this.err(e)));
		return promise;
	}

}

module.exports = Managed;
