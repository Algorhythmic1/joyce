/** Only web URLs are bookmarks; never hand other protocols to the OS. */
export function websiteUrl(input: string): string {
  const value = input.trim();
  if (!value || /\s/.test(value)) throw new Error("Enter a website address, such as example.com.");
  const scheme = value.match(/^([a-z][a-z\d+.-]*):/i);
  if (scheme && !/^https?:$/i.test(scheme[0]) && !/^\d+(?:[/?#]|$)/.test(value.slice(scheme[0].length))) {
    throw new Error("Website addresses must use http or https.");
  }
  let url: URL;
  try { url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`); }
  catch { throw new Error("Enter a valid website address."); }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw new Error("Enter an http or https address without a username or password.");
  }
  return url.href;
}
