#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <rpc.h>
#include "Interface_h.h"

void print_usage(const char* program_name) {
    printf("Usage: %s <server_ip> <port>\n", program_name);
    printf("Exemple: %s 192.168.1.31 55000\n", program_name);
    printf("         %s localhost 55000\n", program_name);
}

int main(int argc, char* argv[]) {
    RPC_STATUS status;
    RPC_WSTR stringBinding = NULL;
    wchar_t server_ip[256];
    wchar_t port[16];
    
    // Vérifier les arguments
    if (argc != 3) {
        print_usage(argv[0]);
        return 1;
    }
    
    // Convertir les arguments en wchar_t
    MultiByteToWideChar(CP_ACP, 0, argv[1], -1, server_ip, 256);
    MultiByteToWideChar(CP_ACP, 0, argv[2], -1, port, 16);
    
    printf("Connexion au serveur %s:%s...\n", argv[1], argv[2]);
    
    // 1. Créer le binding string
    status = RpcStringBindingCompose(
        NULL,                           // UUID objet
        (RPC_WSTR)L"ncacn_ip_tcp",     // Protocole TCP/IP
        server_ip,                      // Adresse du serveur
        port,                           // Port
        NULL,                           // Options
        &stringBinding
    );
    
    if (status != RPC_S_OK) {
        printf("Erreur RpcStringBindingCompose: 0x%x\n", status);
        return 1;
    }
    
    // 2. Créer le binding handle
    status = RpcBindingFromStringBinding(
        stringBinding,
        &MyInterface_IfHandle  // Remplacez par le nom de votre interface
    );
    
    RpcStringFree(&stringBinding);
    
    if (status != RPC_S_OK) {
        printf("Erreur RpcBindingFromStringBinding: 0x%x\n", status);
        return 1;
    }
    
    printf("Connexion reussie!\n");
    
    // 3. Appeler vos fonctions RPC
    RpcTryExcept {
        // Exemple d'appels RPC - remplacez par vos fonctions
        // int result = MaFonctionRPC(param1, param2);
        // printf("Resultat: %d\n", result);
        
        printf("Pret a executer des appels RPC...\n");
        
    }
    RpcExcept(1) {
        unsigned long exception = RpcExceptionCode();
        printf("Exception RPC: 0x%x\n", exception);
        
        // Afficher des erreurs courantes
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
    RpcBindingFree(&MyInterface_IfHandle);
    
    printf("Deconnexion reussie.\n");
    return 0;
}
