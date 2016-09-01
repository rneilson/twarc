'use strict';

var timeouts = new Set();

function isthenable (obj) {
	return obj !== undefined && obj !== null && typeof obj === 'object' && 'then' in obj;
}

function delayloop (callback, time) {
	var args = Array.prototype.slice.call(arguments, 2);
	var timeout = setTimeout(delayed, time);

	function delayed () {
		// Cleanup now-expired timeout
		if (timeout) {
			timeouts.delete(timeout);
		}
		// Call function
		callback.apply(null, args);
	}
}

// TODO: more browser-specific checks?
var nextloop = (typeof setImmediate === 'function')
	? setImmediate 
	: function (callback) {
		var args = [callback, 0];
		if (arguments.length > 1) {
			args.push.apply(args, Array.prototype.slice.call(arguments, 1));
		}
		return setTimeout.apply(null, args);
	};

function iterstep (iter, func, last, res, rej, time, skip) {
	var val;

	while (!last.done) {
		try {
			val = last.value;

			// Advance loop if not in progress
			if (!skip) {
				last = iter.next(val);
				if (last.done) {
					break;
				}
				val = last.value;

				// Check for promise
				if (isthenable(val)) {
					// Set loop to resume (skipping next()) once promise resolved and break; tack on rejector as catch handler
					return val.then(function (result) {
						return iterstep(iter, func, {value: result, done: last.done}, res, rej, time, true);
					}, rej);
				}
			}
			// Officially in progress
			skip = false;

			// Call function if given
			if (func !== undefined) {
				last.value = val = func(val);

				// Check for promise (again)
				if (isthenable(val)) {
					// Set loop to resume once promise resolved and break; tack on rejector as catch handler
					return val.then(function (result) {
						return iterstep(iter, func, {value: result, done: last.done}, res, rej, time);
					}, rej);
				}
			}

			if (time > 0) {
				// Schedule next iterator step after specified delay
				return delayloop(iterstep, time, iter, func, last, res, rej, time);
			}
			else if (time == 0) {
				// Schedule next iterator step for next event loop
				return nextloop(iterstep, iter, func, last, res, rej, time);
			}
			// else continue loop and get next value
		}
		catch (e) {
			// Reject original promise
			return rej(e);
		}
	};

	if (last.done) {
		return res(last.value);
	}
}

function iterlong (iterable, iterfunc, itertime) {
	// Callable sanity check
	if (iterfunc !== undefined && typeof iterfunc !== 'function') {
		throw new Error(`Paramter 'iterfunc' must be a function or undefined`);
	}

	if (isthenable(iterable)) {
		return iterable.then(function (iter) {
			return iterwait(iter, iterfunc);
		});
	}

	var iterator = iterable[Symbol.iterator]();
	var fakeval = {value: undefined, done: false};

	return new Promise(function (resolve, reject) {
		// Schedule stepper function
		if (itertime >= 0) {
			// Iteration job requested to be delayed per-iteration, so start on next event loop
			nextloop(iterstep, iterator, iterfunc, fakeval, resolve, reject, itertime);
		}
		else {
			// Begin actually-immediately
			iterstep(iterator, iterfunc, fakeval, resolve, reject, itertime);
		}
	});
}

iterlong.timeouts = timeouts;

module.exports = iterlong;
