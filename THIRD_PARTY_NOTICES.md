# Third-party notices

ResolvrNow is MIT licensed (see `LICENSE`). It includes or derives from the following third-party material.

## Platform table schemas (`server/src/schema/sdk/sdk-tables.json`)

The table and column definitions in `server/src/schema/sdk/sdk-tables.json` were derived by static analysis
(an AST walk, without executing the package) of the table definition files shipped in the npm package
`@servicenow/sdk-core` version 4.13.6, which is distributed under the MIT License. The derived file contains
table names, labels, inheritance, column names, types, reference targets and similar descriptive metadata.
It is used so that ResolvrNow's data model and REST API stay compatible with existing integrations.

```
MIT License

Copyright (c) 2024 ServiceNow Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and
to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of
the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
IN THE SOFTWARE.
```

## npm dependencies

Runtime dependencies are listed in `server/package.json` and `web/package.json`; each is distributed under its own
license (MIT, Apache-2.0, ISC or BSD), as recorded in the respective package's `node_modules/<name>/LICENSE`.

## Trademarks

ServiceNow is a trademark of ServiceNow, Inc. ResolvrNow is an independent open-source project and is not
affiliated with, endorsed by, or sponsored by ServiceNow, Inc. References to ServiceNow describe API
compatibility only.
