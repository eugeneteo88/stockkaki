-- Remove the wiring self-test row inserted while verifying the feedback endpoint.
delete from public.feedback where page = '/__selftest';
