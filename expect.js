import { dirname, resolve } from 'https://deno.land/std/path/mod.ts';

/**
 * Parse code into tokens according to rules in a grammar.
 *
 * @typedef GrammarRule {(
 *     string |
 *     function(string, string=):array |
 *     RegExp
 * )}
 *
 * @typedef Token{
 *     string |
 *     {type:string, mode:string, line:int, col:int, ?tokens:Token[]}
 * }
 *
 * @param grammar {object<string, GrammarRule|GrammarRule[]>}.  An object of rules objects, where the key is the mode to use.
 * Each rule object has a key with name of the rule's type, and a value that can be either:
 * 1. A string,
 * 2. A regular expression.
 * 3. A function that returns [match] for a match, [match, mode] to enter a new mode, or [match, -1] to pop the mode.
 *    Or undefined if there's no match.
 *    Where match is the string that matches.
 *    Function is given code ahead, code behind, and the list of parsed tokens.
 * 4. An array containing any mix of the above.
 *
 * @param code {string} String to parse.
 * @param mode {?string}
 * @param result {Iterable|Array} Iterable object to populate with result.  Defaults to empty array.
 * @param line {int=} Start counting from this line.
 * @param col {int=} Start counting from this column.
 * @param index {int} Used internally.
 *
 * @return Token[] */
function lex(grammar, code, mode=null, result=[], line=1, col=1, index=0) {
	mode = mode || Object.keys(grammar)[0]; // start in first mode.
	code = code+'';
	while (index < code.length) {
		let current = code.slice(index);

		// 1. Identify token
		let matchType = undefined, token = undefined;
		Token:
		for (var type in grammar[mode]) {
			let value = grammar[mode][type];
			value = Array.isArray(value) ? value : [value]; // Convert single items to array
			for (let pattern of value) { // iterate over array and handle every item type
				if (pattern instanceof RegExp)
					token = (current.match(pattern) || [])[0];
				else if (typeof pattern === 'function')
					[token, matchType] = pattern(current, code.slice(0, index), result) || [];
				else if (current.startsWith(pattern))
					token = pattern;
				if (token)
					break Token; // escape double loop.
		} 	}
		//#IFDEV
		if (!token) {
			let msg = (code.slice(index - 10, index) + '⚠️' + current.slice(0, 20)).replace(/\r/g, '\\r').replace(/\n/g, '\\n');
			throw new Error(`Unknown token within "${mode}" at ${line}:${col}\r\n"${msg}"`);
		}
		//#ENDIF

		// 2. Ascend or descend
		token = Object.assign(token, {type, mode: (matchType && matchType !== -1) ? matchType : mode, line, col});
		if (matchType === -1) // Ascend out of a sub-mode.
			return [...result, token];

		else if (matchType) { // Descend into new mode
			let tokens = [token, ...lex(grammar, code, matchType, [], line, col+token.length, index+token.length)];
			token = Object.assign(tokens.join(''), {type, tokens, mode, line, col});
		}

		// 3. Process token
		index+= token.length;
		result.push(token);

		// 4. Increment line/col number.
		line += (token.match(/\n/g) || []).length; // count line returns
		let lastLn = token.lastIndexOf('\n');
		col = (lastLn >-1 ? -lastLn : col) + token.length;
	}

	return result;
}

/**
 * Grammar for html/js code, including js templates.
 *
 * Known bugs
 * 1. Javascript regex to match regex tokens might not be perfect.  Since no regex can match all regexes?
 */
{
	let braceDepth = 0;
	let templateDepth = 0;
	let whitespace = /^[ \t\v\f\xa0]+/;
	let ln = /^\r?\n/;


	let expr = code => {
		if ((lexHtmlJs.allowHashTemplates && code.startsWith('#{')) || code.startsWith('${')) {
			if (templateDepth <= 0)
				templateDepth = 1;
			braceDepth = 0;
			return [
				code.slice(0, 2),
				'js'
			];
		}
	};

	let template = code => {
		if (code[0] === '`') {
			--templateDepth;
			return ['`', -1];
		}
	};

	let openTag = goInto => code => { // open tag for html element
		let match = code.match(/^<!?[\-_\w\xA0-\uFFFF]*/i) || []; // open tag
		if (match.length)
			return [match[0], goInto];
	};

	let tag = { // html tag within template.
		attribute: /^[\-_$\w\xA0-\uFFFF]*/i,
		string: [
			code => code[0] === "'" ? ["'", 'squote'] : undefined,
			code => code[0] === '"' ? ['"', 'dquote'] : undefined
		],
		equals: '=',
		template,
		tagEnd: code => {
			if (code[0] === '>')
				return ['>', -1];
			if (code.startsWith('/>'))
				return ['/>', -1];
		},
		whitespace: [whitespace, ln],

		unknown: code => lexHtmlJs.allowUnknownTagTokens
			? [code.match(/^\w+|\S/) || []][0] // Don't fail on unknown stuff in html tags.
			: undefined,
	};

	let closeTag = /^<\/[\-_$\w\xA0-\uFFFF]*\s*>/i;

	// Tokens that can occur before a regex.
	// https://stackoverflow.com/a/27120110
	let regexBefore =
		`{ ( [ . ; , < > <= >= == != === !== + - * % << >> >>> & | ^ ! ~ && || ? : = += -= *= %= <<= >>= >>>= &= |= ^= /=`
		.split(/ /g);

	/**
	 * A grammar for parsing js and html within js templates, for use with lex.js. */
	var lexHtmlJs = {

		js: {
			whitespace,
			ln, // Separate from whitespace because \n can be used instead of semicolon to separate js statements.
			semicolon: ';',
			comment: [/^\/\/.*(?=\r?\n)/, /^\/\*[\s\S]*?\*\//],
			template: code => {
				if (code[0] === '`') {
					++templateDepth;
					braceDepth = 0;
					return ['`', 'template'];
				}
			},
			brace1: code => {
				if (code[0] === '{') {
					braceDepth++;
					return ['{']
				}
			},
			brace2: code => {
				if (code[0] === '}') {
					if (braceDepth === 0 && templateDepth)
						return ['}', -1] // pop out of js mode, back to tempate mode.
					braceDepth--;
					return ['}']; // just match
				}
			},
			value: 'null true false Infinity NaN undefined globalThis'.split(/ /g),
			hex: /^0x[0-9a-f]+/i, // Must occur before number.
			number: /^\d*\.?\d+(e\d+)?/, // Must occur before . operator.

			// Regex must occur before / operator.  This matches (almost?) every regular expression, including itself,
			// but can fail in a few cases.
			// TODO: See these to improve parsing of regex:
			// 1. http://stackoverflow.com/questions/172303
			// 2. http://stackoverflow.com/questions/5519596
			// Matches \\ \/ [^/] [...]
			regex: (code, prev, tokens) => {
				let prevToken;
				for (let i=tokens.length-1; i>=0; i--)
					if (tokens[i].type !== 'ln' && tokens[i].type !== 'whitespace' && tokens[i].type !== 'comment') {
						prevToken = tokens[i]+'';
						break;
					}

				if (regexBefore.includes(prevToken)) {
					// Regular expression that matches regular expressions:
					let matches = code.match(/^\/(\\\\|\\\/|\[\^\/]|\[[^]]]|[^/])+\/[agimsx]*/);
					if (matches)
						return [matches[0]];
				}
			},

			operator: (
				'&& || ! => ' +                 // Logic / misc operators
				'<<= >>= &= ^= |= &&= ||= ' +   // Assignment operators
				'& | ^ ~ >>> << >> ' +          // Bitwise operators
				'=== !=== == != >= > <= < ' +   // Comparison operators
				'= **= += -= *= /= %= ??= ' +   // Assignment operators 2
				'++ -- ** + - * / % ' +         // Arithmetic operators
				', ... . ( ) [ ] ? : '			// Other operators
			).split(/ /g),
			keyword: `
				await break case catch class constructor const continue debugger default delete do enum else export extends
				finally for from function if implements import in instanceof interface let new package private protected public
				return static super switch this throw try typeof var void while with yield`.trim().split(/\s+/g),
			string: [/^"(\\\\|\\"|[^"])*"/, /^'(\\\\|\\'|[^'])*'/],
			identifier: /^[_$a-z\xA0-\uFFFF][_$\w\xA0-\uFFFF]*/i // variables, labels, other things?
		},
		html: { // top level html not within javascript.  No other modes go to this mode.
			comment: /^<!--[\s\S]*?-->/,
			closeTag,
			openTag: openTag('tag'),
			text: /^[\s\S]*?(?=<)/,
			// TODO: script tag to go into javascript code.
		},
		template: { // template within javascript
			expr,
			comment: /^<!--[\s\S]*?-->/, // TODO: Comment should allow expressions within it.  We need a templateComment mode.
			closeTag,
			openTag: openTag('templateTag'),
			template,

			// Continue until end of text.
			// supports both ${} and #{} template expressions.
			text: code => [code.match(
				lexHtmlJs.allowHashTemplates  // (?<!\\) is a negative lookbehind to make sure the ${ isn't preceded by an escape \
					? /^[\s\S]*?(?=<|`|(?<!\\)\${|(?<!\\)#{|(?=$))/
					: /^[\s\S]*?(?=<|`|(?<!\\)\${|(?=$))/) || []][0],
		},
		templateTag: { // html tag within template.
			expr,
			...tag
		},
		tag,

		// TODO: template end with `
		squote: { // single quote string within tag
			expr,
			text: /^[\s\S]*?(?=(?<!\\)\${|(?<!\\\$?){|<|`|')/, // TODO: Support hash templates.
			quote: code => code[0] === "'" ? ["'", -1] : undefined
		},

		dquote: { // double quote string within tag.
			expr,
			text: /^[\s\S]*?(?=(?<!\\)\${|(?<!\\\$?){|<|`|")/,
			quote: code => code[0] === '"' ? ['"', -1] : undefined
		},

		// TODO: css?


		// Options:

		// Allow for {...} templates inside js template strings, instead of just ${}
		// Setting this true can cause problems in parsing css, since {} surrounds the rules.
		// Perhaps add a css mode?
		allowHashTemplates: false,
		allowUnknownTagTokens: false,
	};
}

/**
 * Functional regular expressions.
 *
 * A list of arguments to any of these functions is treated as an AND.
 * An array given as a single argument is identical to fregex.or().
 */

/**
 * Allow matching on functions, object properties, and strings.
 * @param rules
 * @returns {function[]} */
var prepare = rules => {
	if (Array.isArray(rules[0]) && rules.length === 1)
		rules = rules[0];

	let result = [];
	for (let i in rules) {
		let rule = rules[i];
		if (typeof rules[i] === 'string')
			result[i] = tokens => tokens[0] == rule; // TODO: is loose equals best?

		else if (Array.isArray(rule)) // must occur before typeof rule === 'object' b/c array is object.
			result[i] = fregex(rule);

		// If an object, test to see if the token has all of the object's properties.
		else if (typeof rule === 'object' && !rule.prototype)
			result[i] = tokens => {
				for (let name in rule)
					if (tokens[0][name] != rule[name])
						return false;
				return 1;
			};

		else
			result[i] = rules[i];
	}

	return result;
};

/**
 * Use functions instead of letters to define a regex.
 *
 * Each function returns the number of tokens to advance if it matches,
 * 0 if we should proceed without matching,
 * or false if it doesn't match.
 */
function fregex(...rules) {
	return tokens => {
		let i = 0;
		for (let rule of prepare(rules)) {
			let used = rule(tokens.slice(i));
			if (used === false) // 0, false, null, or undefined
				return false;

			// True becomes 1
			i += used;
		}
		return i; // returns number of tokens used.
	}
}

/**
 * Advance the number of tokens used by the first child that matches true.
 * TODO: Automatically treat an array given to an and() as an or() ? */
fregex.or = (...rules) =>
	tokens => {
		for (let rule of prepare(rules)) {
			let used = rule(tokens);
			if (used !== false)
				return used;
		}
		return false;
	};


/**
 * Equivalent of /!(abc)/ */
fregex.not = (...rules) => {
	let f = fregex(rules); // re-use
	return tokens =>
		f(tokens) === false ? 0 : false; // If it matches, return false, otherwise advance 0.
};

/**
 * Advance one token if none of the children match.  A "nor"
 * Equivalent to /[^abc]/ */
fregex.nor = (...rules) =>
	tokens => {
		for (let rule of prepare(rules))
			if (rule(tokens) > 0) // rule(tokens) returns the number used.
				return false;
		return 1;
	};


/**
 * Consume either zero or one of the sequences given. */
fregex.zeroOrOne = (...rules) => {
	let f = fregex(rules);
	return tokens => {
		let used = f(tokens);
		if (used === false)
			return 0; // don't fail if no match.
		return used;
	}
};


fregex.xOrMore = (x, ...rules) => {
	let f = fregex(rules); // re-use
	return (tokens) => {
		let total = 0;
		for (let i=0; tokens.length; i++) {
			let used = f(tokens);
			if (used === false)
				return i >= x ? total : false;
			total += used;
			tokens = tokens.slice(used);
		}
		return total;
	}
};

fregex.zeroOrMore = (...rules) => fregex.xOrMore(0, ...rules);
fregex.oneOrMore = (...rules) => fregex.xOrMore(1, ...rules);


/**
 *
 * @param pattern
 * @param haystack
 * @returns {*[]} A slice of the items in haystack that match.
 *     with an added index property designating the index of the match within the haystack array. */
fregex.matchFirst = (pattern, haystack) => {
	let result = fregex.matchAll(pattern, haystack, 1);
	return result.length ? result[0] : null;
};

fregex.matchAll = (pattern, haystack, limit=Infinity) => {
	if (Array.isArray(pattern))
		pattern = fregex(pattern);
	let result = [];

	// Iterate through each offset in haystack looking for strings of tokens that match pattern.
	for (let i = 0; i < haystack.length && result.length < limit; i++) {
		let count = pattern(haystack.slice(i));
		if (count !== false)
			result.push(Object.assign(haystack.slice(i, i + count), {index: i}));
	}
	return result;
};


// Experimental
fregex.lookAhead = (...rules) =>
	tokens => {
		for (let rule of prepare(rules)) {
			let used = rule(tokens);
			if (used === false)
				return false;
		}
		return 0;
	};

/**
 * Experimental
 * Matches the end of the tokens.
 * @param tokens
 * @returns {number|boolean} */
fregex.end = tokens => {
	return !tokens.length ? 0 : false;
};

/**
 * Issues:
 * 1. lex.js may fail on a few regex types.
 *
 * 2. DOM stuff from the command line.
 */

var Expect = {

	regexIndexOf(string, regex, startpos) {
		var indexOf = string.substring(startpos || 0).search(regex);
		return (indexOf >= 0) ? (indexOf + (startpos || 0)) : indexOf;
	},



	/**
	 * Modify filesystem imports to use absolute paths.
	 * TODO: Does this handle every import syntax?
	 * 1. https://developer.mozilla.org/en-US/docs/web/javascript/reference/statements/import
	 * 2.
	 * @param tokens {Token[]}
	 * @param dir {string} */
	rewriteImports(tokens, dir) {
		dir = resolve(dir).replace(/\\/g, '/'); // abs path with forward slashes

		// 1. Build fregex to find imports.
		let ws0 = fregex.zeroOrMore(fregex.or({type: 'whitespace'}, {type: 'ln'}, {type: 'comment'}));
		let isImport = fregex.or(
			['import', ws0, {type:'string'}],
			['import', ws0, '(', ws0, {type:'string'}],
			['from', ws0, {type:'string'}]
		);

		for (let i=0; i<tokens.length; i++) {

			// If matches the fregex.
			let length = isImport(tokens.slice(i));
			if (length) {

				// Find any string tokens and convert them to an absolute path:
				for (let j=i; j<i+length; j++)
					if (tokens[j].type === 'string') {
						let path = tokens[j];
						let path2 = path.slice(1, -1); // slice to remove start/end quote from string token.
						if (dir && !path2.startsWith('http://') && !path2.startsWith('https://')) {
							if (path2.startsWith('/'))
								path = '"file:///' + dir + path2 + '"';
							else
								path = '"file:///' + dir + '/' + path2.slice(2) + '"';
						}
						tokens[j] =path;
						break;
					}
				i+= length;
			}
		}
	},

	/**
	 * Find all strings that occur after @ expect in comments.
	 * @param tokens {Token[]}
	 * @return {{code:string, line:int}[]} */
	findExpects(tokens) {
		let expects = [];
		for (let token of tokens)
			if (token.type==='comment' && token.startsWith('/**')) {

				//console.log(token.line);
				let comment = token.slice(3, -2);
				let lines = comment.split(/\r?\n/g);
				let expect = null;
				for (let i=0; i<lines.length; i++) {
					let line = lines[i];

					let idx = Expect.regexIndexOf(line, /@\w+/);
					if (idx > 0) { // If at a new tag.
						if (expect) { // Save previous expect
							expects.push(expect);
							expect = null;
						}
						if (line.includes('@expect')) // start new expect.
							expect = {code: line.slice(idx+7), line: token.line + i, col: idx+7};
					}
					else if (expect !== null)
						expect.code += '\r\n' + line.replace(/(?<=^\s+)\*/, ' '); // Replace preceding '*' from comment with space.

				}
				if (expect)
					expects.push(expect);

			}
		return expects;
	},


	createExpectCode(expects, file) {
		let expectCode = [];
		let filePath = file.replace(/\\/g, '\\\\');
		for (let expect of expects) {

			// Check if expect is syntactically valid code
			try {
				new Function(expect.code);
			}
			catch (e) {
				console.error(e.toString() + ` in @expect at ${filePath}:${expect.line}:${expect.col-7}`); // -7 to get @expect
				continue;
			}

			let lines = expect.code.split(/\r?\n/g);
			for (let i=0; i<lines.length; i++) {
				let line = lines[i];
				let idx = line.indexOf('//=');
				if (idx !== -1) {
					let code = line.slice(0, idx);
					let expected = line.slice(idx+3).trim();
					let col = line.search(/\S/) + 1;
					if (i === 0 )
						col += expect.col;

					lines[i] = `{ let actual = ${code}, expected=${expected}; if (JSON.stringify(actual) !== JSON.stringify(expected)) console.log("Actual result is " + actual + " ` +
						`but expected " + expected + " in @expect at ${filePath}:${expect.line+i}:${col}."); }`;
				}
			}

			expectCode.push(`try { ${lines.join('\r\n')} } catch(e) { console.error(e.toString() + " in @expect at ${filePath}:${expect.line}:${expect.col-7}."); }`);
		}


		return expectCode.join('\r\n');
	}
};



let dir, file, code;

// Deno.
if (typeof Deno !== 'undefined') {
	file = Deno.args[0];
	if (!file || file==='expect.js') {
		console.error('Please specify a file.');
		Deno.exit();
	}
	dir = dirname(file);
	code = Deno.readTextFileSync(file);
}

// Node.  Unsupported.
else {
	file = process.argv[2];
	//const fs = (await import('fs')).default; // Fails in Node.js // Also makes Terser fail.
	code = fs.readFileSync(file, {encoding:'utf8', flag:'r'});
}


//file = file.replace(/\\/g, '/');

async function main() {

	let tokens = lex(lexHtmlJs, code, 'js');
	let expects = Expect.findExpects(tokens);
	if (expects.length) { // Do nothing if there are no @expect's.

		Expect.rewriteImports(tokens, dir); // in-place
		let expectCode = Expect.createExpectCode(expects, file);

		// Add JSDom so tests that use DOM nodes can work.
		// This still won't make svg work though.
		let code2 =
			`import jsdom_ZZZ from "https://dev.jspm.io/jsdom";
globalThis.document = new jsdom_ZZZ.JSDOM('<!DOCTYPE html>').window.document;
` + tokens.join('') + ';\r\n' + expectCode;


		// let func = new AsyncFunction(code2);
		// func();

		const encodedJs = encodeURIComponent(code2);
		const dataUri = 'data:text/javascript;charset=utf-8,'
			+ encodedJs;
		await import(dataUri);
	}

}

main(); // b/c terser can't handle top level await.
