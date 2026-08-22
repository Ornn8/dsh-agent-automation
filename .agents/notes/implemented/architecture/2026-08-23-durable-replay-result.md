# Durable replay automation result

Completed routing replays now reparse a stored final output with the existing Agent automation-result parser and return the equivalent validated `automationResult`.

Malformed stored output fails closed before any Worker starts. Records without a stored output retain the existing replay result for compatibility; no durable schema or receipt enforcement path changes.
