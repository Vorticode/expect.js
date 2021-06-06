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
	let ln = /^\r?\n/


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
	}

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

export default lexHtmlJs;