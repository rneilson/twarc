'use strict';

var path = require('path');

// Option types
var MASK_TYPE = 3;
var MASK_MULT = 4;
var OPT_BOOL = 1;
var OPT_STRING = 2;
var OPT_COUNT = MASK_MULT | OPT_BOOL;
var OPT_ARRAY = MASK_MULT | OPT_STRING;

function Arghs (config) {
	if (!(this instanceof Arghs)) {
		return new Arghs(config);
	}

	// Internal storage
	this._options = {};
	this._aliases = {};
	this._named = [];
	this._usage = '';
	this._help = false;
	this._desc = {};

	if (config.options) {
		this.options(config.options);
	}
	if (config.named) {
		this.named(config.named);
	}
	if (config.aliases) {
		this.aliases(config.aliases);
	}
	if (config.usage) {
		this.usage(config.usage);
	}
	if (config.help) {
		this.help(config.help);
	}
}

Arghs.prototype.option = function (optname, opttype) {
	switch (opttype) {
		case 'bool':
			this._options[optname] = OPT_BOOL;
			break;
		case 'count':
			this._options[optname] = OPT_COUNT;
			break;
		case 'string':
			this._options[optname] = OPT_STRING;
			break;
		case 'array':
			this._options[optname] = OPT_ARRAY;
			break;
		default:
			throw new Error("Unknown option type for " + optname + ": " + opttype);
	}
	return this;
}

Arghs.prototype.options = function (optionobj) {
	if (optionobj !== null && typeof optionobj === 'object') {
		var optlist = Object.keys(optionobj);
		for (var i = 0; i < optlist.length; i++) {
			var optname = optlist[i];
			this.option(optname, optionobj[optname]);
		}
		return this;
	}
	else {
		throw new Error("'options' must be an object");
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
	if (typeof short !== 'string') {
		throw new Error("Aliases must be strings");
	}
	else if (short.length > 1) {
		throw new Error("Alias '" + short + "' is too long (must be single letter)");
	}
	else if (typeof long !== 'string' || !this._options.hasOwnProperty(long)) {
		throw new Error("Alias '" + short + "' given for invalid option '" + long + "'");
	}
	this._aliases[short] = long;
	return this;
}

Arghs.prototype.aliases = function (aliasobj) {
	if (aliasobj !== null && typeof aliasobj === 'object') {
		var aliaslist = Object.keys(aliasobj);
		var short;
		for (var i = 0; i < aliaslist.length; i++) {
			short = aliaslist[i];
			this.alias(short, aliasobj[short]);
		}
		return this;
	}
	else {
		throw new Error("'aliases' must be an object");
	}
}

Arghs.prototype.usage = function (usagestr) {
	if (typeof usagestr !== 'string') {
		throw new Error("'usage' must be a string");
	}
	// Check for '$0' and/or '$1' substitutions
	usagestr = usagestr.replace('$0', path.basename(process.argv[0])).replace('$1', path.basename(process.argv[1]));
	this._usage = usagestr + '\n';
	return this;
}

Arghs.prototype.help = function (helpval) {
	// Add help option and alias
	this.option('help', 'bool');
	this.alias('h', 'help');
	// Set help string/descriptions
	if (helpval === true || helpval === undefined) {
		// Create help string on demand
		this._help = true;
	}
	else if (helpval !== null && typeof helpval === 'object') {
		// Create help string on demand using given descriptions
		this._help = true;
		this._desc = helpval;
	}
	else if (typeof helpval === 'string') {
		// Prepend usage to given help string
		this._help = helpval + '\n';
	}
	else {
		throw new Error("'help' must be a string, an object, true, or undefined");
	}
	this._desc.help = 'show this help message and exit';
	return this;
}

Arghs.prototype._makeHelp = function (descobj) {
	var prefix = '  ';
	var maxlen = 0;
	var helpstr = 'Options:\n';
	var aliases = {};
	var lines = [];
	var opt, str, keys, i;

	// First create reverse mapping of options -> aliases
	keys = Object.keys(this._aliases);
	for (i = 0; i < keys.length; i++) {
		str = keys[i];
		opt = this._aliases[str];
		aliases[opt] = str;
	}

	// Get and sort option keys
	keys = Object.keys(this._options).sort();
	// Now add options to output array
	for (i = 0; i < keys.length; i++) {
		opt = keys[i];
		if (aliases.hasOwnProperty(opt)) {
			str = prefix + '-' + aliases[opt] + ', --' + opt;
		}
		else {
			str = prefix + '    --' + opt;
		}
		// Get max length for descriptions later
		maxlen = str.length > maxlen ? str.length : maxlen;
		// Push string to output array
		lines.push(str);
	}

	// Now append each string to final (keys and lines should be same length)
	for (i = 0; i < keys.length; i++) {
		opt = keys[i];
		str = lines[i];
		// Pad to maxlen
		str += ' '.repeat(maxlen - str.length);
		// Add description
		if (descobj.hasOwnProperty(opt)) {
			str += prefix + descobj[opt];
		}
		else {
			switch (this._options[opt]) {
				case OPT_BOOL:
					str += prefix + '[bool]';
					break;
				case OPT_COUNT:
					str += prefix + '[count]';
					break;
				case OPT_STRING:
					str += prefix + '[string]';
					break;
				case OPT_ARRAY:
					str += prefix + '[array]';
					break;
			}
		}
		// Append to final string
		helpstr += str + '\n';
	}

	return helpstr;
}

Arghs.prototype.exitWithUsage = function (appendstr) {
	process.stderr.write(this._usage + '\n' + (appendstr || ''));
	process.exit(0);
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
	var arg, opt;
	while (args.length > 0) {
		arg = args.shift();
		opt = undefined;

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
				parsed['?'][arg] = 'Unknown short option: -' + arg;
				continue;
			}
		}
		// Push into arg array and skip rest of processing
		else {
			parsed._.push(arg);
			continue;
		}

		// Check for switch or option
		if (this._options[arg] === OPT_BOOL) {
			if (parsed[arg]) {
				parsed['?'][arg] = 'Multiple invocation of boolean option: --' + arg;
			}
			parsed[arg] = true;
		}
		else if (this._options[arg] === OPT_COUNT) {
			parsed[arg] = (parsed[arg]) ? parsed[arg] + 1 : true;
		}
		else {
			// Check for option=value
			var idx = arg.indexOf('=');

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

			// Store option in the right place
			if (opt) {
				if (this._options[arg] === OPT_ARRAY) {
					// Multiple options get stored as array regardless
					opt = (Array.isArray(opt)) ? opt : [opt];
					for (var i = 0; i < opt.length; i++) {
						if (Array.isArray(parsed[arg])) {
							parsed[arg].push(opt[i]);
						}
						else {
							parsed[arg] = [opt[i]];
						}
					}
				}
				else if (this._options[arg] === OPT_STRING) {
					// Multiple occurences of single options get overwritten
					if (Array.isArray(opt) || parsed[arg]) {
						parsed['?'][arg] = 'Multiple values for single option: --' + arg;
						opt = (Array.isArray(opt)) ? opt[opt.length - 1] : opt;
					}
					parsed[arg] = opt;
				}
				else {
					// Multiple occurences of unknown options get stored as array
					opt = (Array.isArray(opt)) ? opt : [opt];
					for (var i = 0; i < opt.length; i++) {
						if (Array.isArray(parsed.$[arg])) {
							parsed.$[arg].push(opt[i]);
						}
						else if (parsed.$[arg]) {
							parsed.$[arg] = [parsed.$[arg], opt[i]];
						}
						else {
							parsed.$[arg] = opt[i];
						}
					}
				}
			}
			else {
				// Add to invalid list
				parsed['?'][arg] = 'Missing value for option: --' + arg;
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

	// Print help string and exit if help enabled
	if (parsed.help && this._help) {
		this.exitWithUsage((typeof this._help === 'string') ? this._help : this._makeHelp(this._desc));
	}

	return parsed;
}

module.exports = Arghs;
