# delete-zero-byte-files.ps1

# Set the folder you want to clean up
$TargetPath = "C:\Users\mad\git\zoomsaic\.tile_cache"

# Set the log file
$LogFile = "C:\Users\mad\git\zoomsaic\deleted_cache_files.log"

# Get all zero-byte files
$ZeroByteFiles = Get-ChildItem -Path $TargetPath -File -Recurse | Where-Object { $_.Length -eq 0 }

# Delete them and log each one
foreach ($File in $ZeroByteFiles) {
    try {
        # Log before deleting
        Add-Content -Path $LogFile -Value ("Deleted: " + $File.FullName)
        # Delete file
        Remove-Item -Path $File.FullName -Force
    }
    catch {
        Add-Content -Path $LogFile -Value ("Failed to delete: " + $File.FullName + " -- " + $_.Exception.Message)
    }
}

# Summary
Write-Output ("Deleted " + $ZeroByteFiles.Count + " zero-byte files. Log written to " + $LogFile)
