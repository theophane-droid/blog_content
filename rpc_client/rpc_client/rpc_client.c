#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <rpc.h>
#include "Interface_h.h"

void print_usage(const char* program_name) {
    printf("Usage: %s <server_ip> <port>\n", program_name);
    printf("Exemple: %s 192.168.1.31 55000\n", program_name);
}

int main(int argc, char* argv[]) {
    RPC_STATUS status;
    RPC_WSTR stringBinding = NULL;
    handle_t hBinding = NULL;  // Handle de binding
    wchar_t server_ip[256];
    wchar_t port[16];
    
    if (argc != 3) {
        print_usage(argv[0]);
        return 1;
    }
    
    MultiByteToWideChar(CP_ACP, 0, argv[1], -1, server_ip, 256);
    MultiByteToWideChar(CP_ACP, 0, argv[2], -1, port, 16);
    
    printf("Connexion au serveur %s:%s...\n", argv[1], argv[2]);
    
    // 1. Créer le binding string
    status = RpcStringBindingCompose(
        NULL,
        (RPC_WSTR)L"ncacn_ip_tcp",
        server_ip,
        port,
        NULL,
        &stringBinding
    );
    
    if (status != RPC_S_OK) {
        printf("Erreur RpcStringBindingCompose: 0x%x\n", status);
        return 1;
    }
    
    // 2. Créer le binding handle
    status = RpcBindingFromStringBinding(
        stringBinding,
        &hBinding
    );
    
    RpcStringFree(&stringBinding);
    
    if (status != RPC_S_OK) {
        printf("Erreur RpcBindingFromStringBinding: 0x%x\n", status);
        return 1;
    }
    
    printf("Connexion reussie!\n");
    
    // 3. Appeler votre fonction RPC
    RpcTryExcept {
        int param1 = 42;
        int outNumber = 0;
        
        printf("Appel de MyRemoteProc...\n");
        
        // Appel de votre fonction - le handle est passé automatiquement
        MyRemoteProc(hBinding, param1, &outNumber);
        
        printf("Resultat: outNumber = %d\n", outNumber);
    }
    RpcExcept(1) {
        unsigned long exception = RpcExceptionCode();
        printf("Exception RPC: 0x%x\n", exception);
        
        switch (exception) {
            case RPC_S_SERVER_UNAVAILABLE:
                printf("Serveur non disponible\n");
                break;
            case RPC_S_CALL_FAILED:
                printf("Appel echoue\n");
                break;
            case RPC_S_COMM_FAILURE:
                printf("Echec de communication\n");
                break;
            default:
                printf("Erreur RPC inconnue\n");
        }
    }
    RpcEndExcept
    
    // 4. Libérer le binding
    status = RpcBindingFree(&hBinding);
    if (status != RPC_S_OK) {
        printf("Erreur RpcBindingFree: 0x%x\n", status);
    }
    
    printf("Deconnexion reussie.\n");
    return 0;
}
