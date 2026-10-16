// Writes each product's layout from one shared skeleton, so the three stay alike where they should.
// Run: node templates/build.mjs  (then seed with scripts/templates/seed.mjs)
import fs from "node:fs";

const AVATAR = "https://txniotmoskghmzfqvplz.supabase.co/storage/v1/object/public/uploads/mailerlite/kp4MQOwL9maVOofFD1iOM5hSwAoDciZC2vsjIKxF-1f836950c471.jpg";

function layout({ font, fontLink, border, radius, background = "#ffffff", signature, bio }) {
	const card = bio
		? `
<tr><td class="row" style="padding:48px 50px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="border-top:1px solid #000000;font-size:0;line-height:0;">&nbsp;</td></tr></table></td></tr>
<tr><td class="row" style="padding:24px 50px 0;font-family:${font};font-size:16px;line-height:1.65;color:#7f8c8d;">${signature}</td></tr>
<tr><td class="row" style="padding:24px 50px 40px;">
<table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td width="80" valign="top"><img src="${AVATAR}" width="80" height="80" alt="Rafal" style="display:block;width:80px;height:80px;border-radius:80px;"></td>
<td width="24"></td>
<td valign="middle" style="font-family:${font};font-size:14px;line-height:1.65;color:#515856;">${bio}</td>
</tr></table>
</td></tr>`
		: "";
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="x-apple-disable-message-reformatting">
<title>{{subject}}</title>
${fontLink ? `<link href="${fontLink}" rel="stylesheet">\n` : ""}<style>
body { margin: 0; padding: 0; -webkit-text-size-adjust: 100%; }
table { border-collapse: collapse; }
@media (max-width: 639px) {
  .wrapper { width: 100% !important; }
  .row { padding-left: 20px !important; padding-right: 20px !important; }
}
</style>
</head>
<body style="margin:0;padding:0;background:${background};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${background};">
<tr><td align="center" style="padding:20px 8px;">
<table role="presentation" class="wrapper" width="640" cellpadding="0" cellspacing="0" style="width:100%;max-width:640px;background:#ffffff;${border ? `border:1px solid ${border};border-collapse:separate;` : ""}${radius ? `border-radius:${radius};border-collapse:separate;overflow:hidden;` : ""}">
<tr><td class="row" style="padding:${border || bio ? "48px 50px 16px" : "16px 20px"};font-family:${font};font-size:${bio ? 16 : 14}px;line-height:1.65;color:${bio ? "#515856" : "#000000"};">
{{content}}
</td></tr>${card}
</table>
<table role="presentation" width="640" cellpadding="0" cellspacing="0" style="width:100%;max-width:640px;">
<tr><td class="row" style="padding:24px ${border || bio ? 50 : 20}px 32px;font-family:${font};">{{footer}}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
`;
}

// Spacing follows the MailerLite originals: paragraphs 16px with 1.65 line height and room between
// them, and wide gaps around pictures, lists and buttons. A title that opens the email (.title) has
// more room under it than a section heading.
function css({ heading, headingFont, h1, titleGap, h2, link, button, buttonRadius, buttonWeight = "normal", image }) {
	const font = headingFont ? ` font-family: ${headingFont};` : "";
	return `.body p { margin: 0 0 20px; }
.body h1, .title { margin: 40px 0 20px; font-size: ${h1}px; line-height: 1.25; font-weight: 700; color: ${heading};${font} }
.title { margin-bottom: ${titleGap}px; }
.body h2 { margin: 40px 0 16px; font-size: ${h2}px; line-height: 1.25; font-weight: 700; color: ${heading};${font} }
.body h3 { margin: 32px 0 12px; font-size: 18px; line-height: 1.3; font-weight: bold; color: ${heading};${font} }
.body a { color: ${link}; text-decoration: underline; }
.body img { display: block; max-width: 100%; height: auto; margin: 36px auto; border-radius: ${image}; }
.figure { margin: 0; }
.captioned { display: block; max-width: 100%; height: auto; margin: 36px auto 8px; border-radius: ${image}; }
.caption { margin: 0 0 36px; font-size: 13px; line-height: 1.65; font-weight: bold; }
.body ul, .body ol { margin: 32px 0; padding-left: 24px; }
.body li { margin: 0 0 4px; }
.body blockquote { margin: 0 0 20px; padding-left: 16px; border-left: 3px solid #d1d3d3; color: #515856; }
.body code { font-family: ui-monospace, Menlo, monospace; font-size: 14px; background: #f4f4f5; padding: 2px 4px; }
.body hr { border: 0; border-top: 1px solid #d1d3d3; margin: 40px 0; }
.btn-table { margin: 36px 0 56px; }
.btn-table-center { margin: 36px auto 56px; }
.btn-cell { border-radius: ${buttonRadius}; background: ${button}; }
.btn { padding: 20px 25px; border-radius: ${buttonRadius}; color: #ffffff; font-size: 18px; line-height: 20px; font-weight: ${buttonWeight}; text-decoration: none; }
`;
}

const PRODUCTS = {
	poof: {
		layout: {
			font: "'Poppins',Helvetica,Arial,sans-serif",
			fontLink: "https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700&display=swap",
			border: "#6466F1",
			radius: "20px",
			signature: "- Rafal from Poof -",
			bio: "Hi, I am Rafal - the founder of Poof.<br>I created it to help creators like you easily edit images. Hope you find Poof helpful!",
		},
		css: { heading: "#000000", h1: 27, titleGap: 60, h2: 22, link: "#363636", button: "#6466F1", buttonRadius: "10px", image: "12px" },
	},
	supadata: {
		layout: {
			font: "'Space Mono',ui-monospace,Menlo,monospace",
			fontLink: "https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&display=swap",
			border: "#363636",
			radius: "",
			signature: "- Rafal from Supadata -",
			bio: "Hi, I am Rafal - the founder of Supadata.<br>I created it to help makers like you easily access public web data. Hope you find Supadata helpful!",
		},
		css: { heading: "#000000", h1: 27, titleGap: 60, h2: 24, link: "#363636", button: "#000000", buttonRadius: "0px", image: "0px" },
	},
	// Gistly's automation emails: a white card with round corners on light gray, Inter text, Poppins
	// headings and purple buttons.
	gistly: {
		layout: {
			font: "'Inter',Helvetica,Arial,sans-serif",
			fontLink: "https://fonts.googleapis.com/css2?family=Inter:wght@400;700&family=Poppins:wght@700&display=swap",
			border: "",
			radius: "30px",
			background: "#f6f6f6",
			signature: "- Rafal from Gistly -",
			bio: "Hi, I am Rafal - the solo maker of Gistly.<br>I created it to help people like you make the most of their time spent on YouTube. Hope you'll find Gistly useful!",
		},
		css: {
			heading: "#000000",
			headingFont: "'Poppins',Helvetica,Arial,sans-serif",
			h1: 27,
			titleGap: 32,
			h2: 22,
			link: "#a855f7",
			button: "#a855f7",
			buttonRadius: "6px",
			image: "6px",
		},
	},
};

for (const [slug, { layout: l, css: c }] of Object.entries(PRODUCTS)) {
	fs.writeFileSync(new URL(`./${slug}.html`, import.meta.url), layout(l));
	fs.writeFileSync(new URL(`./${slug}.css`, import.meta.url), css(c));
}
console.log("wrote", Object.keys(PRODUCTS).join(", "));
