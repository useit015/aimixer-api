#!/bin/bash
rsync -a --exclude="node_modules" . root@api.aimixer.io:/home/aimixer-api/
