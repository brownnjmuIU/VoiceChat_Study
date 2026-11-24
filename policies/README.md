# policies/

Put the **exact** privacy-policy text participants read in Qualtrics here, one file per policy:

```
policies/openai.md
policies/anthropic.md
```

Every `.md` or `.txt` file in this folder (except this README and files starting with `_`) is appended to the system prompt at boot, so the chatbot answers from the same versions the participant just read instead of from what the model remembers. Both conditions get the identical prompt.

- Use the same version you put in the survey, and note the date you copied it (top line of the file is fine).
- Plain text is best. Strip site navigation, cookie banners and footers.
- Boot log shows `Policy loaded: openai (N chars)` for each file. With no files, the bot still works but answers from general knowledge, which can be out of date or wrong about specifics.
- Combined limit is 200,000 characters.
