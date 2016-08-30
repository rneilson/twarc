'use strict';

// Option types (bitstuff)
var OPT_BOOL = 0x01;
var OPT_STR = 0x02;
var OPT_MULT = 0x04;
var MASK_TYPE = 0x03;
var MASK_MULT = 0x04;

function Arghs (config) {

	// Internal storage
	this._options = {};
	this._aliases = {};
	this._named = [];
	this._help = null;
	this._usage = null;

	if (config.options) {
		this.options(config.options);
	}

	if (config.flags) {
		this.flags(config.flags);
	}

	if (config.named) {
		this.named(config.named);
	}

	if (config.aliases) {
		this.aliases(config.aliases);
	}
}

Arghs.prototype.options = function (optionlist) {
	if (Array.isArray(optionlist)) {
		// Seed options requiring values
		for (var i = 0; i < optionlist.length; i++) {
			this._options[optionlist[i]] = OPT_STR;
		}
		return this;
	}
	else {
		throw new Error("'options' must be an array");
	}
}

Arghs.prototype.flags = function (flaglist) {
	if (Array.isArray(flaglist)) {
		// Seed boolean options
		for (var i = 0; i < flaglist.length; i++) {
			this._options[flaglist[i]] = OPT_BOOL;
		}
		return this;
	}
	else {
		throw new Error("'flags' must be an array");
	}
}

Arghs.prototype.named = function (names) {
	if (Array.isArray(names) || typeof config.named === 'string') {
		if (Array.isArray(names)) {
			for (var i = 0; i < names.length; i++) {
				this._named.push(names[i]);
			}
		}
		else {
			this._named.push(names);
		}
		return this;
	}
	else {
		throw new Error("'named' must be an array or string");
	}
}

Arghs.prototype.alias = function (short, long) {
	if (typeof short === 'string' && typeof long === 'string') {
		this._aliases[short] = long;
	}
	else {
		throw new Error("Aliases must be strings");
	}
}

Arghs.prototype.aliases = function (aliasobj) {
	if (aliasobj !== null && typeof aliasobj === 'object') {
		var aliaslist = Object.keys(aliasobj);
		var short;
		for (var i = 0; i < aliaslist.length; i++) {
			short = aliaslist[i];
			this._aliases[short] = aliasobj[short];
		}
		return this;
	}
	else {
		throw new Error("'aliases' must be an object");
	}
}

Arghs.prototype.parse = function (argv) {
	var args;
	if (argv === undefined) {
		args = process.argv.slice(2);
	}
	else if (typeof argv === 'string') {
		args = argv.split(' ');
	}
	else if (Array.isArray(argv)) {
		args = argv
	}
	else {
		throw new Error("'args' must be undefined, string, or array");
	}

	// Properties _, $, ?, and '--' should be non-enumerable, non-configurable, non-writeable
	var parsed = {};
	Object.defineProperty(parsed, '_',  { value: [] });
	Object.defineProperty(parsed, '$',  { value: {} });
	Object.defineProperty(parsed, '?',  { value: {} });
	Object.defineProperty(parsed, '--',  { value: [] });

	// Slice and dice
	while (args.length > 0) {
		var arg = args.shift();

		// Check for long forms
		if (arg.startsWith('--')) {
			// Slice off '--'
			arg = arg.substr(2);
			// Check if stopping
			if (arg === '') {
				// Copy remaining args to overflow and stop processing
				Array.prototype.push.apply(parsed['--'], args);
				break;
			}
		}
		// Check for short forms
		else if (arg.startsWith('-')) {
			// Slice off '-'
			arg = arg.substr(1);

			// Pull apart multi-switch arg
			if (arg.length > 1) {
				// Put remaining switches back into queue
				args.unshift('-' + arg.substr(1));
				arg = arg[0];
			}

			// Check for valid alias
			if (this._aliases[arg]) {
				arg = this._aliases[arg];
			}
			else {
				parsed['?'][arg] = `Unknown option: ${'-' + arg}`;
				continue;
			}
		}
		// Push into arg array and skip rest of processing
		else {
			parsed._.push(arg);
			continue;
		}

		// Check for switch or option
		if ((this._options[arg] & MASK_TYPE) === OPT_BOOL) {
			if ((this._options[arg] & MASK_MULT) === OPT_MULT) {
				parsed[arg] = parsed[arg] ? parsed[arg] + 1 : 1;
			}
			else {
				parsed[arg] = true;
			}
		}
		else {
			// Check for option=value
			var idx = arg.indexOf('=');
			var opt;

			if (idx >= 0) {
				opt = arg.substr(idx + 1).split(',');
				arg = arg.substr(0, idx);
			}
			// Consume additional arg
			else if (args.length > 0) {
				opt = args.shift();
				if (opt.startsWith('-')) {
					// Put back additional arg
					args.unshift(opt);
					opt = undefined;
				}
			}

			if (opt) {
				var target = ((this._options[arg] & MASK_TYPE) === OPT_STR) ? parsed : parsed.$;

				// Multiple occurences of options get stored as array if allowed
				if ((this._options[arg] & MASK_MULT) === OPT_MULT) {
					// Create array if req'd
					if (!target[arg]) {
						target[arg] = [];
					}
					// Store value(s)
					if (Array.isArray(opt)) {
						Array.prototype.push.apply(target[arg], opt);
					}
					else {
						target[arg].push(opt);
					}
				}
				else {
					// Multiple values given for a non-multiple option get overwritten
					target[arg] = (Array.isArray(opt)) ? opt[opt.length - 1] : opt;
				}
			}
			else {
				// Add to invalid list
				parsed['?'][arg] = `Missing value for option: --${arg}`;
			}
		}
	}

	// Set named args
	for (var j = 0; j < this._named.length; j++) {
		if (parsed._.length > 0) {
			// Pull named arg from positional args, put in parsed object
			parsed[this._named[j]] = parsed._.shift();
		}
		else {
			// Explicitly include named args in parsed object
			parsed[this._named[j]] = undefined;
		}
	}

	return parsed;
}

module.exports = Arghs;
