-- What a series has spent this month is its owner's to know. The function that works it out answers for any
-- series it is given, so it is the worker's alone; the web app reads a user's own rows instead, which row-level
-- security already limits to that user. (Its own file: the one before it had been applied when this was seen.)
revoke execute on function public.series_month_usd(uuid) from studio_web;
