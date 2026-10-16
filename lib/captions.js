// A picture with a caption under it: the image's Markdown title, ![](https://…/shot.png "The caption"),
// also when the picture is a link ([![](…/thumb.jpg "Video title")](https://youtu.be/…)).
// The picture gets class "captioned" and the caption a paragraph of class "caption", so a product's
// template can style both; the built-in design styles them inline.
const CAPTIONED_IMAGE_STYLE = "display:block;max-width:100%;height:auto;margin:24px auto 8px;border-radius:8px;";
const CAPTION_STYLE = "margin:0 0 24px;font-size:13px;line-height:1.6;color:#71717a;";

function escapeHtml(value) {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

// The image token of a paragraph that holds only a picture, linked or not.
function onlyImage(tokens) {
	const parts = tokens.filter((token) => !(token.type === "text" && !token.raw.trim()));
	if (parts.length !== 1) return null;
	const [part] = parts;
	if (part.type === "image") return part;
	if (part.type === "link" && part.tokens?.length === 1 && part.tokens[0].type === "image") return part.tokens[0];
	return null;
}

export function captionExtension({ isEmail = false } = {}) {
	return {
		renderer: {
			paragraph(token) {
				const image = onlyImage(token.tokens ?? []);
				if (!image?.title?.trim()) return false;
				const picture = this.parser
					.parseInline(token.tokens)
					.replace(/<img\b/i, isEmail ? `<img class="captioned" style="${CAPTIONED_IMAGE_STYLE}"` : '<img class="captioned"')
					.replace(/\stitle="[^"]*"/i, "");
				const style = isEmail ? ` style="${CAPTION_STYLE}"` : "";
				return `<p class="figure"${isEmail ? ' style="margin:0;"' : ""}>${picture}</p>\n<p class="caption"${style}>${escapeHtml(image.title.trim())}</p>\n`;
			},
		},
	};
}
