# Glimmerfell Blog: how to publish a post

1. Copy `post-template.html` and rename it, e.g. `why-scale-matters.html` (lowercase, hyphens).
2. Replace everything marked ✏️ (title, description, date, canonical URL, cover image).
3. Write the post inside `<article class="post-body">`. The media blocks you can copy are listed in a comment at the bottom of the template.
4. Put images and video files in the `media/` folder and refer to them as `media/filename.jpg`.
5. On `index.html`, move the old "latest post" into the cards grid, then point the feature block at the new post.

Media in one line each:
- Image: `<figure><img src="media/x.jpg" alt="..."><figcaption>Caption</figcaption></figure>`
- YouTube / Vimeo: `<figure data-video="https://youtu.be/XXXX"></figure>` (paste the normal share link)
- Own video: `<figure data-video="media/x.mp4" data-poster="media/x.jpg"></figure>`
- Silent loop: add `data-loop`. Vertical: `data-ratio="9:16"`. Wider: `class="wide"` or `class="full"`.

The menu and footer for every blog page live in `blog.js` (section 1), so a menu change is made there once.
Keep images around 2000px wide and under ~500 KB; keep self-hosted videos short and compressed (H.264 MP4).
