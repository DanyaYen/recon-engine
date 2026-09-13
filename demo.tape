# VHS Tape Script for recon-engine terminal demo
# To render: vhs demo.tape

Output demo.gif

Set Shell "bash"
Set FontSize 15
Set Width 1280
Set Height 720
Set Padding 20
Set Theme "Catppuccin Mocha"
Set WindowBar Colorful
Set TypingSpeed 25ms

Sleep 500ms

# Step 1: Parse statement with instant format auto-detection
Type "recon parse tests/fixtures/camt053/camt053-standard-v2.xml"
Sleep 400ms
Enter
Sleep 3.5s

# Step 2: Clear terminal for clean matching output
Type "clear"
Enter
Sleep 400ms

# Step 3: High-throughput 3-stage matching with fee tolerance and multi-currency totals
Type "recon match --statement tests/fixtures/revolut/revolut-wire-invoices.csv --invoices tests/fixtures/invoices/invoices.json --yes"
Sleep 400ms
Enter
Sleep 5s
