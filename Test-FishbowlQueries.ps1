# Fishbowl legacy API query check.
# Settings come from parameters or environment variables:
# ServerHost, ServerPort, UserName, UserPassword, AppId, AppName, AppDesc.
# The first login for a new integrated application returns status 1110 or 1112
# until that application is approved in the Fishbowl Client:
# Setup -> Settings -> Integrated Apps.

param(
    [string]$ServerHost = $env:ServerHost,
    [int]$ServerPort = $(if ($env:ServerPort) { [int]$env:ServerPort } else { 28192 }),
    [string]$UserName = $env:UserName,
    [string]$UserPassword = $env:UserPassword,
    [string]$AppId = $env:AppId,
    [string]$AppName = $env:AppName,
    [string]$AppDesc = $env:AppDesc
)

$ErrorActionPreference = "Stop"

function Require-Setting {
    param([string]$Name, [string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) {
        throw "Missing $Name. Pass -$Name or set the $Name environment variable."
    }
}

Require-Setting "ServerHost" $ServerHost
Require-Setting "UserName" $UserName
Require-Setting "UserPassword" $UserPassword
Require-Setting "AppId" $AppId
Require-Setting "AppName" $AppName
Require-Setting "AppDesc" $AppDesc

$TestQueries = @(
    "SELECT id, abbreviation, name FROM countryconst",
    "SELECT id, name, code, activeFlag FROM uom",
    "SELECT id, userName, firstName, lastName, activeFlag FROM sysuser",
    "SELECT id, name, defaultFlag FROM company",
    "SELECT id, name, activeFlag FROM carrier"
)

function Escape-XmlText {
    param([string]$Text)
    if ($null -eq $Text) { return "" }
    return (($Text -replace '&', '&amp;') -replace '<', '&lt;') -replace '>', '&gt;'
}

function Send-FbiPacket {
    param($Stream, [string]$XmlString)
    $payloadBytes = [System.Text.Encoding]::UTF8.GetBytes($XmlString)
    $lengthPrefix = [System.Net.IPAddress]::HostToNetworkOrder([int]$payloadBytes.Length)
    $lenBytes = [System.BitConverter]::GetBytes($lengthPrefix)
    $Stream.Write($lenBytes, 0, 4)
    $Stream.Write($payloadBytes, 0, $payloadBytes.Length)
    $Stream.Flush()
}

function Read-FbiPacket {
    param($Stream)
    $lenBytes = New-Object byte[] 4
    $read = 0
    while ($read -lt 4) {
        $chunk = $Stream.Read($lenBytes, $read, 4 - $read)
        if ($chunk -le 0) { throw "Connection closed unexpectedly while reading header." }
        $read += $chunk
    }

    $payloadLength = [System.Net.IPAddress]::NetworkToHostOrder([System.BitConverter]::ToInt32($lenBytes, 0))
    if ($payloadLength -le 0) { return "" }

    $payloadBytes = New-Object byte[] $payloadLength
    $total = 0
    while ($total -lt $payloadLength) {
        $chunk = $Stream.Read($payloadBytes, $total, $payloadLength - $total)
        if ($chunk -le 0) { throw "Connection closed unexpectedly while reading payload." }
        $total += $chunk
    }

    return [System.Text.Encoding]::UTF8.GetString($payloadBytes, 0, $total)
}

function Get-FbiStatus {
    param($Response, [string[]]$Tags)
    foreach ($tag in $Tags) {
        $node = $Response.SelectSingleNode("//$tag")
        if ($null -ne $node -and $node.statusCode) {
            return @{
                Code = [string]$node.statusCode
                Message = [string]$node.statusMessage
            }
        }
    }
    return @{ Code = ""; Message = "" }
}

$md5 = [System.Security.Cryptography.MD5]::Create()
$pwdHash = $md5.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($UserPassword))
$EncryptedPassword = [Convert]::ToBase64String($pwdHash)

$tcp = New-Object System.Net.Sockets.TcpClient
try {
    Write-Host "Connecting to Fishbowl Server at ${ServerHost}:${ServerPort}..." -ForegroundColor Cyan
    $tcp.Connect($ServerHost, $ServerPort)
    $stream = $tcp.GetStream()

    $loginXml = @"
<FbiXml>
    <Ticket><Key></Key></Ticket>
    <FbiMsgsRq>
        <LoginRq>
            <IAID>$(Escape-XmlText $AppId)</IAID>
            <IAName>$(Escape-XmlText $AppName)</IAName>
            <IADescription>$(Escape-XmlText $AppDesc)</IADescription>
            <UserName>$(Escape-XmlText $UserName)</UserName>
            <UserPassword>$(Escape-XmlText $EncryptedPassword)</UserPassword>
        </LoginRq>
    </FbiMsgsRq>
</FbiXml>
"@

    Send-FbiPacket -Stream $stream -XmlString $loginXml
    $loginResponseRaw = Read-FbiPacket -Stream $stream
    [xml]$loginResponse = $loginResponseRaw

    $loginStatus = Get-FbiStatus -Response $loginResponse -Tags @("LoginRs", "FbiMsgsRs")
    $statusCode = $loginStatus.Code
    $ticketKey = [string]$loginResponse.FbiXml.Ticket.Key

    if ($statusCode -in @("1110", "1112")) {
        Write-Host ""
        Write-Host "[APPROVAL REQUIRED]" -ForegroundColor Yellow
        Write-Host "This client application ('$AppName') has not been approved yet." -ForegroundColor Yellow
        Write-Host "In the Fishbowl Client, open Setup -> Settings -> Integrated Apps, find '$AppName', and click Approve." -ForegroundColor Yellow
        Write-Host "The status should become Accepted. This requires the Edit Integrated Apps right." -ForegroundColor Yellow
        return
    }

    if ($statusCode -ne "1000" -or [string]::IsNullOrWhiteSpace($ticketKey) -or $ticketKey -eq "null") {
        $detail = $loginStatus.Message
        if ([string]::IsNullOrWhiteSpace($detail)) { $detail = "No ticket was returned." }
        Write-Host "Login Failed (Code $statusCode): $detail" -ForegroundColor Red
        return
    }

    Write-Host "Login successful. Ticket established." -ForegroundColor Green

    foreach ($query in $TestQueries) {
        Write-Host ""
        Write-Host "--------------------------------------------------" -ForegroundColor DarkGray
        Write-Host "Executing: $query" -ForegroundColor Yellow

        $queryXml = @"
<FbiXml>
    <Ticket><Key>$(Escape-XmlText $ticketKey)</Key></Ticket>
    <FbiMsgsRq>
        <ExecuteQueryRq>
            <Query>$(Escape-XmlText $query)</Query>
        </ExecuteQueryRq>
    </FbiMsgsRq>
</FbiXml>
"@

        Send-FbiPacket -Stream $stream -XmlString $queryXml
        $queryResponseRaw = Read-FbiPacket -Stream $stream
        [xml]$queryResponse = $queryResponseRaw

        $queryStatus = Get-FbiStatus -Response $queryResponse -Tags @("ExecuteQueryRs", "FbiMsgsRs")
        $qStatus = $queryStatus.Code
        if ($qStatus -eq "1000") {
            $rows = @($queryResponse.SelectNodes("//Row"))
            if ($rows.Count -gt 0) {
                $csvList = foreach ($row in $rows) { $row.InnerText }
                $csvText = [string]::Join([Environment]::NewLine, $csvList)
                $csvData = @(ConvertFrom-Csv -InputObject $csvText)
                Write-Host "Success ($($csvData.Count) records returned). Preview:" -ForegroundColor Green
                $csvData | Select-Object -First 5 | Format-Table -AutoSize
            } else {
                Write-Host "Success (0 records returned)." -ForegroundColor DarkYellow
            }
        } else {
            Write-Host "Query Failed (Code $qStatus): $($queryStatus.Message)" -ForegroundColor Red
        }
    }
}
catch {
    Write-Host ""
    Write-Host "[ERROR] Line $($_.InvocationInfo.ScriptLineNumber): $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "Details: $($_.ScriptStackTrace)" -ForegroundColor DarkGray
}
finally {
    if ($null -ne $tcp) {
        $tcp.Close()
    }
}
