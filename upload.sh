#!/bin/bash
rsync -a --exclude=".env" --exclude="node_modules" . root@api.aimixer.io:/home/aimixer-api/
