/**
 * Issues:
 * 1. lex.js may fail on a few regex types.
 *
 * 2. DOM stuff from the command line.
 */
import {dirname, resolve} from "https://deno.land/std/path/mod.ts";

import lex from './lex.js';
import lexHtml from './lex-htmljs.js';
import fregex from './fregex.js';

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

	let tokens = lex(lexHtml, code, 'js');
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



